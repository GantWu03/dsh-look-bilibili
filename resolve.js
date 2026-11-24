/**
 * Turn whatever the user pastes into a concrete Bilibili playback target.
 *
 * The embed player (`player.bilibili.com/player.html`) is the only thing that
 * actually plays video, and it only understands URL parameters: `bvid`+`page`
 * for UGC, `seasonId`+`episodeId` for PGC, `t` for the start offset, `muted`.
 * Everything else (a watch-page link, a b23.tv short link, a bare BV number)
 * has to be normalised here, and the target is pre-checked against the public
 * Bilibili API so an unplayable video fails as a readable message instead of a
 * silent black frame.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
}

// Bilibili risk control answers -412/-352 to cookie-less API calls; a buvid3/
// buvid4 pair from the public `finger/spi` endpoint is enough to get through.
let buvidCache = { value: '', at: 0 }

async function buvidCookie(fetchImpl) {
  if (buvidCache.value && Date.now() - buvidCache.at < 600000) return buvidCache.value
  try {
    const response = await fetchImpl('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(8000),
    })
    const payload = await response.json()
    const b3 = payload && payload.data && payload.data.b_3
    const b4 = payload && payload.data && payload.data.b_4
    if (!b3) return ''
    buvidCache = { value: `buvid3=${b3}${b4 ? `; buvid4=${b4}` : ''}`, at: Date.now() }
    return buvidCache.value
  } catch {
    return ''
  }
}

const SHORT_HOSTS = new Set(['b23.tv', 'bili2233.cn', 'b23.wtf', 'bili22.cn'])
const BV_RE = /BV[0-9A-Za-z]{10}/
const AV_RE = /\bav(\d{1,12})\b/i
const EP_RE = /\bep(\d{3,10})\b/i
const SS_RE = /\bss(\d{3,10})\b/i

const CODE_HINTS = {
  '-404': '视频不存在',
  '-403': '接口拒绝访问（可能需要登录或被风控）',
  '-352': '触发风控，稍后重试',
  '-412': '请求被 B 站风控拦截（连点太快的常见结果）',
  62002: '视频不可见（私有或已删除）',
  62004: '视频审核中',
  62012: '仅 UP 主自己可见',
  87007: '需要大会员或付费',
}

export function parseTime(value) {
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return Number(text)
  const colon = text.split(':')
  if (colon.length > 1 && colon.every((part) => /^\d+$/.test(part.trim()))) {
    return colon.reduce((acc, part) => acc * 60 + Number(part.trim()), 0)
  }
  let total = 0
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(h|m|s)/gi)) {
    const amount = Number(match[1])
    const unit = match[2].toLowerCase()
    total += unit === 'h' ? amount * 3600 : unit === 'm' ? amount * 60 : amount
  }
  return Math.round(total)
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function parseInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { kind: 'unknown', error: '输入是空的' }

  let url = null
  const found = text.match(/https?:\/\/[^\s"'<>]+/)
  if (found) {
    url = found[0]
  } else {
    const bare = text.replace(/^\/+/, '')
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(bare)) url = `https://${bare}`
  }
  if (url) return parseUrl(url, text)

  const bv = text.match(BV_RE)
  if (bv) return { kind: 'video', bvid: bv[0], page: 1, t: 0, raw: text }
  const av = text.match(AV_RE)
  if (av) return { kind: 'video', aid: Number(av[1]), page: 1, t: 0, raw: text }
  const ep = text.match(EP_RE)
  if (ep) return { kind: 'episode', id: Number(ep[1]), t: 0, raw: text }
  const ss = text.match(SS_RE)
  if (ss) return { kind: 'season', id: Number(ss[1]), t: 0, raw: text }
  return {
    kind: 'unknown',
    error: '没认出这是 B 站视频：支持 BV 号、av 号、b23.tv 短链、视频页链接、番剧 ep/ss 链接',
  }
}

function parseUrl(url, raw) {
  let parsedUrl
  try {
    parsedUrl = new URL(url)
  } catch {
    return { kind: 'unknown', error: '链接格式看不懂' }
  }

  const host = parsedUrl.hostname.replace(/^www\./, '').toLowerCase()
  if (SHORT_HOSTS.has(host)) return { kind: 'short', url, raw }

  const params = parsedUrl.searchParams
  const t = parseTime(params.get('t') ?? params.get('start') ?? '')
  const paramPage = Number(params.get('p') ?? params.get('page') ?? '') || 0

  if (host === 'player.bilibili.com') {
    const episodeId = Number(params.get('episodeId') || 0)
    const seasonId = Number(params.get('seasonId') || 0)
    const bv = (params.get('bvid') || '').match(BV_RE)
    if (episodeId) return { kind: 'episode', id: episodeId, t, raw }
    if (seasonId) return { kind: 'season', id: seasonId, t, raw }
    if (bv) return { kind: 'video', bvid: bv[0], page: Number(params.get('page') || params.get('p') || 1) || 1, t, raw }
    return { kind: 'unknown', error: '播放器链接里没有 bvid / episodeId' }
  }

  const epPath = parsedUrl.pathname.match(/\/bangumi\/play\/(ep\d+)/i)
  if (epPath) return { kind: 'episode', id: Number(epPath[1].slice(2)), t, raw }
  const ssPath = parsedUrl.pathname.match(/\/bangumi\/play\/(ss\d+)/i)
  if (ssPath) return { kind: 'season', id: Number(ssPath[1].slice(2)), t, raw }

  const pathBv = parsedUrl.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)
  const anyBv = url.match(BV_RE)
  const bvid = pathBv ? pathBv[1] : anyBv ? anyBv[0] : null
  if (bvid) return { kind: 'video', bvid, page: paramPage || 1, t, raw }

  const avPath = parsedUrl.pathname.match(/\/video\/av(\d+)/i)
  const anyAv = url.match(AV_RE)
  const aid = avPath ? Number(avPath[1]) : anyAv ? Number(anyAv[1]) : 0
  if (aid) return { kind: 'video', aid, page: paramPage || 1, t, raw }

  return { kind: 'unknown', error: `没在这个链接里找到视频（${host}）` }
}

async function getJson(fetchImpl, url, headers = HEADERS) {
  let response
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(9000) })
  } catch (error) {
    return { ok: false, error: `请求失败：${String((error && error.message) || error)}` }
  }
  try {
    return { ok: true, data: await response.json() }
  } catch {
    return { ok: false, error: `接口返回了非 JSON（HTTP ${response.status}）` }
  }
}

async function requestJson(fetchImpl, url) {
  const first = await getJson(fetchImpl, url)
  const code = first.ok && first.data ? first.data.code : undefined
  if (code !== -412 && code !== -352) return first
  const cookie = await buvidCookie(fetchImpl)
  if (!cookie) return first
  return getJson(fetchImpl, url, { ...HEADERS, Cookie: cookie })
}

function apiError(label, payload) {
  const code = payload && payload.code
  const hint = CODE_HINTS[code] ? `（${CODE_HINTS[code]}）` : ''
  return `${label}返回 ${code}：${(payload && payload.message) || '未知错误'}${hint}`
}

async function expandShort(url, fetchImpl) {
  let current = url
  for (let hop = 0; hop < 5; hop += 1) {
    let response
    try {
      response = await fetchImpl(current, { headers: HEADERS, redirect: 'manual' })
    } catch {
      return null
    }
    if (response.body && typeof response.body.cancel === 'function') {
      try {
        await response.body.cancel()
      } catch {}
    }
    const location = response.headers.get('location')
    if (!location) return current
    current = new URL(location, current).toString()
    let host = ''
    try {
      host = new URL(current).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      return null
    }
    if (!SHORT_HOSTS.has(host)) return current
  }
  return current
}

async function describeVideo(parsed, fetchImpl) {
  const query = parsed.bvid ? `bvid=${parsed.bvid}` : `aid=${parsed.aid}`
  const json = await requestJson(fetchImpl, `https://api.bilibili.com/x/web-interface/view?${query}`)
  if (!json.ok) return { ok: false, error: json.error }
  if (!json.data || json.data.code !== 0) return { ok: false, error: apiError('B站接口', json.data) }

  const video = json.data.data
  if (!video || !video.bvid) return { ok: false, error: '接口没返回视频信息' }

  const pages = (Array.isArray(video.pages) ? video.pages : []).map((entry) => ({
    page: Number(entry.page) || 0,
    cid: entry.cid,
    part: String(entry.part ?? ''),
    duration: Number(entry.duration) || 0,
  }))
  const pageCount = Math.max(1, pages.length)
  const page = Math.min(Math.max(1, Number(parsed.page) || 1), pageCount)

  const warnings = []
  if (Number(video.state) !== 0) warnings.push('视频状态异常，可能已下架或审核中')
  const rights = video.rights || {}
  if (rights.is_pay || rights.is_ugc_pay) warnings.push('付费内容：外链播放器可能只有试看片段或直接报错')

  return {
    ok: true,
    kind: 'video',
    bvid: video.bvid,
    aid: Number(video.aid) || 0,
    title: String(video.title ?? ''),
    owner: String((video.owner && video.owner.name) || ''),
    cover: String(video.pic ?? ''),
    page,
    pageCount,
    pages,
    t: Number(parsed.t) || 0,
    warnings,
  }
}

async function describePgc(parsed, fetchImpl) {
  const query = parsed.kind === 'episode' ? `ep_id=${parsed.id}` : `season_id=${parsed.id}`
  const json = await requestJson(fetchImpl, `https://api.bilibili.com/pgc/view/web/season?${query}`)
  if (!json.ok) return { ok: false, error: json.error }
  if (!json.data || json.data.code !== 0) return { ok: false, error: apiError('番剧接口', json.data) }

  const season = (json.data.result || {})
  const episodes = (Array.isArray(season.episodes) ? season.episodes : []).map((entry) => ({
    id: Number(entry.id) || 0,
    title: String(entry.title || entry.long_title || ''),
    duration: Number(entry.duration) || 0,
    badge: String(entry.badge || ''),
  }))

  const episodeId = parsed.kind === 'episode' ? Number(parsed.id) : episodes[0] ? episodes[0].id : 0
  const current = episodes.find((entry) => entry.id === episodeId)

  return {
    ok: true,
    kind: 'pgc',
    seasonId: Number(season.season_id) || 0,
    episodeId,
    title: String(season.season_title || season.title || ''),
    episodeTitle: current ? current.title : '',
    episodes,
    t: Number(parsed.t) || 0,
    warnings: [],
  }
}

export async function describe(raw, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch
  let parsed = parseInput(raw)

  if (parsed.kind === 'short') {
    const expanded = await expandShort(parsed.url, fetchImpl)
    if (!expanded) return { ok: false, error: 'b23.tv 短链没能展开（网络失败或链接已失效）' }
    parsed = parseInput(expanded)
    if (parsed.kind === 'short') return { ok: false, error: 'b23.tv 短链没能展开到具体视频' }
  }

  if (parsed.kind === 'unknown') return { ok: false, error: parsed.error }
  if (parsed.kind === 'episode' || parsed.kind === 'season') return describePgc(parsed, fetchImpl)
  return describeVideo(parsed, fetchImpl)
}

export function buildEmbedUrl(target) {
  const params = new URLSearchParams()
  if (target.kind === 'pgc' && target.episodeId) {
    if (target.seasonId) params.set('seasonId', String(target.seasonId))
    params.set('episodeId', String(target.episodeId))
  } else {
    params.set('bvid', String(target.bvid ?? ''))
    params.set('page', String(target.page || 1))
  }
  params.set('autoplay', '1')
  params.set('danmaku', '0')
  params.set('muted', target.muted === false ? '0' : '1')
  if (Number(target.t) > 0) params.set('t', String(Math.round(Number(target.t))))
  return `https://player.bilibili.com/player.html?${params.toString()}`
}
