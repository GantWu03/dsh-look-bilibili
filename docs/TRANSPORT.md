# 浮动控制点（进度条 / 暂停 / 上下集 / 开关）

背景视频本身是 B 站官方外链播放器，它自带的标题条、进度条、按钮**没有关闭参数**。
这一层做的事是：整套自建控件（播放控制 + 背景开关）收成一个可拖动的小圆点，
鼠标移上去才展开成一张卡片，通过两条不同的通道驱动播放器。

```
收起：  ●                        （14px 小点，带一颗绿芯）
展开：
        ┌──────────────────────────────────────┐
   ● ── │ [⏮] [━━━━●━━━] [⏸] [⏭] 12:34 / 40:38 │
        │ B站背景 P2 [关][弱][中][强][静音][换片] │
        └──────────────────────────────────────┘
```

- **悬停展开**，移开约 0.4s 后自动收起；展开时卡片以圆点为竖直中心向两侧长出来，
  圆点本身不移动（否则指针会掉出去，形成"展开-收起"抖动）。
- **拖动圆点**可把整个控件挪到任意位置，位置存在 `localStorage`
  （`biliPlayer.transport.v1`），下次启动还在那儿；**双击圆点**回到左下角。
- 拖动时卡片跟随指针，松手后如果指针仍在控件上就保持展开。
- 自动收起由"指针是否真的落在控件矩形内"判断，而不是靠 `pointerenter/leave`
  事件——展开会改变布局，浏览器会补发假的 `leave`，那是闪烁的根源。

## 两条通道

| 操作 | 通道 | 原因 |
|---|---|---|
| 拖动/点击进度条 | 改写 iframe 的 `t=` 参数（重载） | 外链播放器跨域，`currentTime` 读不到；它的进度条对合成点击**不提交** seek |
| ⏸ / ▶ 暂停 | Win32 `PostMessage` 注入点击 | 播放按钮是普通 DOM 控件，合成鼠标消息有效 |
| ⏮ / ⏭ 上/下集 | 改写 `page=` / `episodeId=` 参数 | 换集本身就是换 URL |
| 隐藏播放器自带的 UI | 加载后注入**一次** `WM_MOUSEMOVE` | B 站播放器收到鼠标活动后 ~3s 自动淡出，之后不再自动出现（iframe 是 `pointer-events:none`，真实鼠标进不去） |
| 关 / 弱 / 中 / 强 / 静音 / 换片 | 只改 React 状态（`enabled`/`level`/`muted`），必要时重写 `src` | 这些本来就是插件自己的开关，不碰播放器 |

## 两个踩过的坑

1. **每秒闪一次**：卡片 `ref` 回调是内联函数时，React 每次渲染都会"解绑→重绑"，
   而播放进度 ticker 每秒重渲染一次，于是展开动画每秒重播一遍，看起来像"关掉又出现"。
   修法：`ref` 回调用 `useCallback` 固定身份，动画只在真正挂载时跑一次。
2. **展开即收起**：靠 `onPointerLeave` 收起时，卡片长出来会改变布局，浏览器补发
   `pointerleave` → 收起 → 又进入 → 再展开。改成监听 `pointermove` 并拿控件矩形判断。

## 为什么暂停要注入

DSH 的 Host 插件跑在 `ELECTRON_RUN_AS_NODE` 子进程里（`process.type === null`），
拿不到 `webContents.sendInputEvent`；105 个 Host 服务里也没有窗口/输入服务。
所以 `pointer.ps1` 用一个常驻 PowerShell 进程直接往窗口句柄 `PostMessage`
（`WM_MOUSEMOVE` / `WM_LBUTTONDOWN` / `WM_LBUTTONUP`），**不移动真实光标**。

- 首次调用要付 `Add-Type` 编译 + 进程祖先查询，约 3.5s；Host 在插件加载时就 `warm()` 预热。
- 之后每条命令 2–5ms（实测 2/3/4ms），点击 110–220ms（含 100ms 的按下/抬起间隔）。
- 助手进程随 Host 插件卸载而结束。

## 坐标

播放器页面里的控件位置（CSS px，已用 `document.elementsFromPoint` 在
900×506 … 1920×1080 六个尺寸上验证一致）：

| 控件 | 公式 |
|---|---|
| 进度条 | `x = 12 + (W − 24) × ratio`，`y = H − 76`（16px 高，中心） |
| 播放/暂停 | `x = 33`，`y = H − 39` |

换算到窗口客户区（物理像素）：`client = (iframe.left + pageX) × devicePixelRatio`。
DSH 的页面原点和客户区原点重合（客户区 2560×1516，视口 1272×754，DPR 2.0125）。

### 两个必须处理的坑

1. **iframe 比视口宽**：背景用 `width:max(100vw,177.78vh)` 居中铺满，
   窗口越"高"左右裁得越多。播放按钮左边缘会跑出窗口（`x = −3`），
   所以要 `clamp` 到可视区（实测裁到 `x = 2`，仍在按钮的 36px 宽度内）。
2. **命中测试**：整层是 `pointer-events:none`，合成消息会被 Chromium 的
   命中测试跳过。注入前后临时把 iframe 和自建控件切成 `auto`/`none`，
   保持 180ms 后复原（`PostMessage` 只是入队，必须等目标线程处理完）。

## 已知限制

- **窗口必须是前台窗口**。Chromium 会丢弃非活动窗口的合成鼠标消息
  （真实点击会先激活窗口，所以正常使用路径没问题；脚本驱动需要先 `{"action":"activate"}`）。
- 进度条是**乐观估计**：它的位置来自"上次 seek + 每秒 +1s"，真实 `currentTime`
  读不到，所以时间显示是近似值（切歌/缓冲会漂）。
- 每次 seek 都会重载 iframe（黑一下 + 约 1s），这是 `t=` 参数路线的固有代价。

## 外部驱动

```bash
# 查窗口（含 isForeground / isMinimized / 客户区 / DPI）
curl http://127.0.0.1:<port>/bili-player/pointer
# 注入
curl -X POST http://127.0.0.1:<port>/bili-player/pointer \
  -H 'content-type: application/json' -d '{"action":"click","x":534,"y":1401}'
```

`action`：`info` / `activate` / `move` / `click` / `drag`（`x2`,`y2`）/ `wheel`（`delta`）/ `reset`。
坐标是**窗口客户区物理像素**。

## 实测日志（`reports/player.jsonl`）

```
{"ev":"transport-move","x":389,"y":447}                    # 拖动小点后的新位置（居中锚点）
{"ev":"transport-reset"}                                    # 双击小点回到左下角
{"ev":"seek","ratio":0.0218,"t":49,"duration":2438}         # 拖进度条 -> t=49
{"ev":"apply","src":"...&t=49"}                             # iframe 重载
{"ev":"step","delta":1,"page":3}                            # 下一集
{"ev":"inject","action":"click","x":2,"y":1440,"ok":true,"ms":120}  # 注入 B 站播放按钮
```
