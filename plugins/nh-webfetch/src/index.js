// 本地 Capacitor 外掛 NhWebFetch 的 JS 端。只有 src/services/nhSource.js 可以 import 這個模組。
//
// NhWebFetch.fetchText({ url, timeoutMs })  → { status, contentType, body, ...診斷欄位 }
//   成功與失敗（err.data）都附診斷：href、title、stage、probeHref、probeTitle、readyTitle、
//   reloaded、mainFrameError、webMessageListener、webViewVersion（見 NhWebFetchPlugin.diag）
// NhWebFetch.showChallenge({ url })         → { passed: boolean }
// NhWebFetch.clearSession()                 → {}
// NhWebFetch.takeSharedText()               → { text }：取出並清除瀏覽器「分享」進來的文字（沒有時為 ''）
// NhWebFetch.addListener('shareReceived')   ：App 已在背景時收到新的分享（之後呼叫 takeSharedText 取出）
import { registerPlugin } from '@capacitor/core'

export const NhWebFetch = registerPlugin('NhWebFetch')
