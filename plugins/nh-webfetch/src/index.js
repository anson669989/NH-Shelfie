// 本地 Capacitor 外掛 NhWebFetch 的 JS 端。只有 src/services/nhSource.js 可以 import 這個模組。
//
// NhWebFetch.fetchText({ url, timeoutMs })  → { status, contentType, body, ...診斷欄位 }
//   成功與失敗（err.data）都附診斷：href、title、stage、probeHref、probeTitle、readyTitle、
//   reloaded、mainFrameError、webMessageListener、webViewVersion（見 NhWebFetchPlugin.diag）
// NhWebFetch.showChallenge({ url })         → { passed: boolean }
// NhWebFetch.clearSession()                 → {}
import { registerPlugin } from '@capacitor/core'

export const NhWebFetch = registerPlugin('NhWebFetch')
