# B站视频背景（可换片）

把 B 站外链播放器（`player.bilibili.com/player.html`）铺满 DSH 界面当背景，并且可以在界面里直接换视频。

## 它怎么工作

1. **Host 半**（`index.js` + `resolve.js` + `pointer.js`）在 GUI 自己的原点上开五条路由：
   - `/bili-player/report`：Client 把实测数据以 JSONL 追加到 `%TEMP%/dsh-look-bilibili/player.jsonl`（可用 `config.reportDir` 改）；
   - `/bili-player/resolve?text=…`：把用户粘进来的东西（视频页链接、BV 号、av 号、b23.tv 短链、番剧 ep/ss、播放器链接）解析成 `bvid + page` 或 `seasonId + episodeId`，顺便用 B 站公开接口预检能不能播；
   - `/bili-player/control`：外部命令通道，脚本/Agent 可以 POST 一条命令来换片，不用点鼠标；
   - `/bili-player/pointer`：Win32 输入注入（点 B 站自带按钮用，见 `TRANSPORT.md`）；
   - `/bili-player/splash`：开机动画视频（支持 `Range`）。
2. **Client 半**（`client.js`）注册到 `shell.overlay`（`.overlayLayer{z-index:20;pointer-events:none}`）：
   - 一个 `position:fixed;inset:0` 的层，里面是 `<iframe>`，用 `width:max(100vw,177.78vh)` 居中铺满（CSS 版 `object-fit:cover`）；
   - 视频 `opacity` 三档 + 径向 `mask`：中心几乎透明、边缘全开，正文区不受影响；
   - 整层 `pointer-events:none`，点击穿透到聊天页，只有左下角浮控件和弹出面板可点。

## 界面

左下角是一个**浮动小圆点**（整套控件默认收起，只占 14px）：

```
●                       ← 平时就一个小点，悬停才展开

● ┌──────────────────────────────────────┐
  │ [⏮] [━━━━●━━━] [⏸] [⏭] 12:34 / 40:38 │   ← 播放控制（详见 TRANSPORT.md）
  │ B站背景 P2 [开/关] [弱][中][强] [静音/有声] [换片] │
  └──────────────────────────────────────┘
```

- 悬停展开、移开约 0.4s 收起；
- **拖动圆点**可把整套控件挪到任意位置（位置存 `localStorage` 的
  `biliPlayer.transport.v1`，下次启动还在那儿），**双击圆点**回到左下角；
- 「换片」面板跟着控件走，出现在它的正上方。

点「换片」弹出面板：

- 粘贴链接 / BV 号 / 短链 → 「解析」；
- 解析成功显示标题、原作者、（多 P 时）分 P 列表、（番剧时）剧集列表；
- 「起点」可填秒数或 `mm:ss`，对应嵌入播放器的 `t` 参数；
- 「用这个当背景」写入状态并重设 iframe `src`，播放器立刻切过去。

选择结果存在 `localStorage`（`biliPlayer.state.v1`），下次打开还是上次那个视频。

## 已知边界

- 换片就是改 iframe URL，所以**能换什么由嵌入播放器决定**：番剧/大会员/付费/版权限制的内容可能黑屏或报错，因此解析阶段会预检并给出提示；
- 覆盖层在内容之上，视频不可能真正垫在文字下面，只能靠透明度 + 蒙版让步；
- 背景模式下播放器自己的控件点不到（除浮控件/面板外整层穿透），所以另做了一个自建控制条 + Win32 注入；
- 未登录时清晰度受限（实测 360P 档）；`high_quality` 参数在 4.x embed 里无效；
- 音频默认静音（`muted=1`），浮控件可切换。

## 外部命令

```bash
curl -X POST http://127.0.0.1:<port>/bili-player/control \
  -H 'content-type: application/json' \
  -d '{"action":"apply","input":"https://www.bilibili.com/video/BV18paz6kE8m?p=6","t":600}'
```

`action` 可为 `apply`（带 `input`，可附带 `t`/`page`/`episodeId`）、`set`（`page`/`t`/`muted`/`enabled`/`level`）、`panel`（`open`）。

## 卸载

插件管理里禁用或移除「B站视频背景（可换片）」（`dsh-look-bilibili`）。

## 开机动画（splash）

### 资源

- 动画文件：`assets/splash.mp4`（H.264 + AAC，1344×768，24fps，4.458s，约 3 MB）——**换成你自己的 mp4 即可**，同名覆盖
- Host 路由 `/bili-player/splash` 直接把这个文件吐出去（同源 → 无 CORS、无 file:// 限制，支持 `Range` 206）

### 行为

- 页面加载 = 应用启动时，全屏白底播放一次，播完（`ended`）后 420ms 淡出并卸载；
- 视频用 `object-fit: contain` + 白底，任何窗口比例下都是原比例居中（上下留白）；
- 点击任意位置 / `Esc` / `Space` / `Enter` 可跳过；9 秒兜底超时；
- 默认**有声**（动画自带一段两音启动音）；想静音发 `{"action":"splash","sound":false}`，选择记在 `localStorage: biliPlayer.splash.sound`；
- 只在**冷启动**播一次：标记存在 `sessionStorage: biliPlayer.splash.played`（模块级变量会被热重载重置，sessionStorage 不会）。所以热重载不重播、应用重启后会重新播、切换会话也不重播。

### 外部命令

```bash
B=http://127.0.0.1:<port>
curl -X POST $B/bili-player/control -d '{"action":"splash"}'              # 静音重播
curl -X POST $B/bili-player/control -d '{"action":"splash","sound":true}' # 带声音重播并记住
```

### 实测

```
{"ev":"splash-show","run":3,"viewport":{"w":1272,"h":754,"dpr":2.01},"root":{"x":0,"y":0,"w":1272,"h":754},"video":{"w":1272,"h":754}}
{"ev":"splash-meta","duration":4.458333,"width":1344,"height":768,"muted":false}
{"ev":"splash-end","reason":"ended"}          ← 4.46s 处自然结束
```

- 根节点铺满 1272×754（CSS px），视频元素同尺寸；
- 截屏实测（`ffmpeg gdigrab` 桌面 2560×1600，动画进行到 ~2.1s）：白底占 68.6%，粉色主体（R-G ≈ 18）集中在画面右侧 58%~83%，与 mp4 原帧的内容分布一致；
- 用 `ffmpeg` 从 mp4 抽帧对比：t=0.4s 内容 14.7%、t=1.2s 28.2%、t≥2.2s 约 30%，说明角色是 1s 内滑入、之后保持 —— 和动画设计一致；
- `PrintWindow` 截这个 `<video>` 会得到“只有底部一条”的假象（视频层没被正确合成进 GDI 缓冲），改用 `gdigrab` 抓桌面才是真实画面，这一点记在这免得下次误判。

### 注意

- 宿主侧代码（`/bili-player/splash` 路由）改动不会热更，需要重装一次 bundle（`remove_bundle` + `install_bundle`，已在本次验证中做过）；
- 客户端代码改动会随 `client-hmr` 热更，热更**不会**重播开机动画（sessionStorage 标记还在），要重播用控制通道 `{"action":"splash"}`；
- 换动画只要替换 `assets/splash.mp4`（或改 `SPLASH_SRC` 指向别的资源）；删掉这个文件也不影响背景本身，只是不再有开屏动画。
