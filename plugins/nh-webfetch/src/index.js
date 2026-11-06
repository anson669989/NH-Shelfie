// 本地 Capacitor 外掛 NhWebFetch 的 JS 端。只有 src/services/nhSource.js 可以 import 這個模組。
//
// NhWebFetch.fetchText({ url, timeoutMs })  → { status, contentType, body }
// NhWebFetch.showChallenge({ url })         → { passed: boolean }
// NhWebFetch.clearSession()                 → {}
import { registerPlugin } from '@capacitor/core'

export const NhWebFetch = registerPlugin('NhWebFetch')
