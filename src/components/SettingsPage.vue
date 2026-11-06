<template>
  <section class="page settings-page">
    <div class="settings-inner">
      <!-- 外觀 -->
      <h2>{{ t('settings.appearance') }}</h2>
      <div class="card">
        <div class="row col">
          <span>{{ t('settings.themeColor') }}</span>
          <div class="swatches">
            <button
              v-for="c in THEME_COLORS"
              :key="c"
              class="swatch"
              :class="{ on: settings.theme_color === c }"
              :style="{ background: c }"
              :aria-label="c"
              @click="setSetting('theme_color', c)"
            />
          </div>
        </div>
        <div class="row col">
          <span>{{ t('settings.darkMode') }}</span>
          <div class="segmented">
            <button
              v-for="m in ['system', 'light', 'dark']"
              :key="m"
              :class="{ on: settings.dark_mode === m }"
              @click="setSetting('dark_mode', m)"
            >
              {{ t('settings.dark.' + m) }}
            </button>
          </div>
        </div>
        <div class="row">
          <span>{{ t('settings.gridColumns') }}</span>
          <div class="segmented compact">
            <button
              v-for="n in [2, 3, 4, 5]"
              :key="n"
              :class="{ on: Number(settings.grid_columns) === n }"
              @click="setSetting('grid_columns', n)"
            >
              {{ n }}
            </button>
          </div>
        </div>
      </div>

      <!-- 語言 -->
      <h2>{{ t('settings.language') }}</h2>
      <div class="card">
        <div class="row">
          <select class="select" :value="settings.language" @change="setSetting('language', $event.target.value)">
            <option value="">{{ t('settings.language.auto') }}</option>
            <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.label }}</option>
          </select>
        </div>
      </div>

      <!-- 資料 -->
      <h2>{{ t('settings.data') }}</h2>
      <div class="card">
        <div class="row col">
          <div class="btn-row">
            <button class="btn primary" :disabled="busy" @click="doExport">{{ t('settings.export') }}</button>
            <button class="btn" :disabled="busy" @click="fileInput.click()">{{ t('settings.import') }}</button>
            <input ref="fileInput" type="file" accept=".csv,text/csv,text/comma-separated-values" hidden @change="doImport" />
          </div>
          <span class="muted small">{{ lastExportText }}</span>
          <span v-if="exportOverdue" class="notice warn small">{{ t('settings.exportReminder') }}</span>
        </div>
        <div v-if="pendingCount > 0 || queueRunning" class="row">
          <span>{{ t('settings.pending', { n: pendingCount }) }}</span>
          <button class="btn" :disabled="queueRunning" @click="resumeQueue">
            {{ queueRunning ? t('settings.queueRunning') : t('settings.resumeQueue') }}
          </button>
        </div>
        <div class="row">
          <button class="btn text" :disabled="busy || queueRunning" @click="refetchMissing">
            {{ t('settings.refetchMissing') }}
          </button>
        </div>
        <div class="row">
          <button class="btn text" @click="calcSize">{{ sizeText || t('settings.calcSize') }}</button>
          <button class="btn text" @click="clearCache">{{ t('settings.clearCache') }}</button>
        </div>
      </div>

      <!-- 進階 -->
      <h2>{{ t('settings.advanced') }}</h2>
      <div class="card">
        <div class="row col">
          <span>{{ t('settings.testConnection') }}</span>
          <div class="btn-row">
            <button class="btn" :disabled="testing" @click="doTest">
              {{ testing ? t('settings.testing') : t('settings.testConnection') }}
            </button>
          </div>
        </div>
        <!-- 以下僅開發者模式（關於 → 版本 連點 7 次）顯示 -->
        <div v-if="devMode" class="row col">
          <span class="muted small">{{ logText }}</span>
        </div>
        <div v-if="devMode" class="row col">
          <span>{{ t('settings.fetchMode') }}</span>
          <div class="segmented">
            <button
              v-for="m in ['auto', 'native', 'webview']"
              :key="m"
              :class="{ on: settings.fetch_mode === m }"
              @click="setSetting('fetch_mode', m)"
            >
              {{ t('settings.fetchMode.' + m) }}
            </button>
          </div>
          <span class="muted small">{{ t('settings.lastFetchVia', { via: settings.last_fetch_ok || '—' }) }}</span>
        </div>
        <div v-if="devMode" class="row">
          <button class="btn text" :disabled="testing" @click="doResetVerification">
            {{ t('settings.resetVerification') }}
          </button>
        </div>
        <details v-if="devMode" class="row col">
          <summary>{{ t('settings.endpoints') }}</summary>
          <p class="notice warn small">{{ t('settings.endpointWarning') }}</p>
          <label class="small">{{ t('settings.endpointDetail') }}</label>
          <input v-model="ep.endpoint_detail" class="input mono" spellcheck="false" autocapitalize="off" />
          <label class="small">{{ t('settings.endpointCdn') }}</label>
          <input v-model="ep.endpoint_cdn" class="input mono" spellcheck="false" autocapitalize="off" />
          <label class="small">{{ t('settings.endpointPage') }}</label>
          <input v-model="ep.endpoint_page" class="input mono" spellcheck="false" autocapitalize="off" />
          <div class="btn-row">
            <button class="btn primary" @click="saveEndpoints">{{ t('settings.save') }}</button>
            <button class="btn text" @click="restoreEndpoints">{{ t('settings.restoreDefault') }}</button>
          </div>
        </details>
      </div>

      <!-- 關於 -->
      <h2>{{ t('settings.about') }}</h2>
      <div class="card">
        <div class="row">
          <button class="btn text" @click="alertDialog(t('help'), { title: t('settings.help') })">
            {{ t('settings.help') }}
          </button>
        </div>
        <div class="row version-row" @click="onVersionTap">
          <span>{{ t('settings.version') }}</span>
          <span class="muted">{{ version }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { App as CapApp } from '@capacitor/app'
import { settings, setSetting, resetEndpoints, DEFAULT_ENDPOINTS } from '../services/settings.js'
import {
  exportCsv,
  previewCsvImport,
  commitCsvImport,
  pendingCount,
  queueRunning,
  runQueue,
  markMissingCoversPending,
  coversSize,
  clearTempCache,
  testConnection,
  fetchLogSummary,
  verifyChallenge,
  resetVerification,
} from '../services/library.js'
import { validateEndpointTemplate } from '../services/parse.js'
import { AppError, E, toAppError } from '../services/errors.js'
import { t, errText, LANGUAGES, currentLang } from '../i18n.js'
import { alertDialog, confirmDialog, toast, formatBytes } from '../ui.js'

const props = defineProps({ active: Boolean })

const THEME_COLORS = ['#ed2553', '#e91e63', '#7c4dff', '#3f51b5', '#039be5', '#009688', '#43a047', '#ff9800', '#607d8b']

const fileInput = ref(null)
const busy = ref(false)
const testing = ref(false)
const sizeText = ref('')
const logText = ref('')
const version = ref('')
const ep = reactive({ ...DEFAULT_ENDPOINTS })
const devMode = computed(() => settings.dev_mode === '1')

const lastExportText = computed(() => {
  const s = Number(settings.last_export_at)
  if (!s) return t('settings.neverExported')
  return t('settings.lastExport', { date: new Date(s * 1000).toLocaleString(currentLang.value) })
})
const exportOverdue = computed(() => {
  const s = Number(settings.last_export_at)
  return !s || Date.now() / 1000 - s > 30 * 86400
})

watch(
  () => props.active,
  async (active) => {
    if (!active) return
    for (const k of Object.keys(DEFAULT_ENDPOINTS)) ep[k] = settings[k]
    refreshLog()
    if (!version.value) {
      try {
        const info = await CapApp.getInfo()
        version.value = `${info.version} (${info.build})`
      } catch {
        version.value = 'web'
      }
    }
  },
  { immediate: true },
)

async function refreshLog() {
  const s = await fetchLogSummary()
  logText.value = s.total
    ? t('settings.fetchLog', { total: s.total, rate: `${Math.round((s.ok / s.total) * 100)}%` }) +
      (Object.keys(s.byCode).length
        ? ' · ' + Object.entries(s.byCode).map(([k, v]) => `${k}×${v}`).join(', ')
        : '')
    : t('settings.fetchLogEmpty')
}

async function doExport() {
  busy.value = true
  try {
    await exportCsv()
  } catch (err) {
    // 使用者取消分享時不顯示錯誤
    if (!/cancel/i.test(String(err?.message || err))) toast(errText(toAppError(err)))
  } finally {
    busy.value = false
  }
}

async function doImport(ev) {
  const file = ev.target.files?.[0]
  ev.target.value = ''
  if (!file) return
  busy.value = true
  try {
    const res = await previewCsvImport(file)
    const reasons = res.skipped
      .slice(0, 20)
      .map((s) => '・' + t('import.reason.' + s.reason, { line: s.line }))
      .join('\n')
    const msg =
      t('import.preview', { ok: res.ok.length, skip: res.skipped.length }) +
      (res.skipped.length ? `\n\n${t('import.reasons')}\n${reasons}${res.skipped.length > 20 ? '\n…' : ''}` : '')
    if (!res.ok.length) {
      await alertDialog(msg)
      return
    }
    const ok = await confirmDialog(msg, { okText: t('import.confirm') })
    if (!ok) return
    await commitCsvImport(res.ok)
    toast(t('import.done', { n: res.ok.length }), 3500)
    runQueue().catch((e) => toast(errText(toAppError(e))))
  } catch (err) {
    toast(errText(toAppError(err)), 3500)
  } finally {
    busy.value = false
  }
}

function resumeQueue() {
  runQueue().catch((e) => toast(errText(toAppError(e))))
}

async function refetchMissing() {
  const n = await markMissingCoversPending()
  toast(t('settings.refetchMarked', { n }))
  if (n) resumeQueue()
}

async function calcSize() {
  const s = await coversSize()
  sizeText.value = t('settings.coversSize', { count: s.count, size: formatBytes(s.bytes) })
}

async function clearCache() {
  await clearTempCache()
  toast(t('settings.cleared'))
}

async function doTest() {
  testing.value = true
  try {
    let r = await testConnection()
    if (r.detail === E.CHALLENGE) {
      // 需要手動通過 Cloudflare 驗證：通過後自動重測一次
      const go = await confirmDialog(errText(new AppError(E.CHALLENGE)), { okText: t('challenge.verify') })
      if (!go) return
      const passed = await verifyChallenge({ title: t('challenge.title'), closeLabel: t('common.close') })
      if (!passed) {
        toast(t('challenge.notPassed'))
        return
      }
      r = await testConnection()
    }
    const fmt = (v) => (v === 'ok' ? '✓ OK' : `✗ ${errText(new AppError(v))}`)
    await alertDialog(t('settings.testResult', { detail: fmt(r.detail), cover: r.detail === 'ok' ? fmt(r.cover) : '—' }), {
      title: t('settings.testConnection'),
      // 診斷只在開發者模式顯示（任務 003）
      diagnostics: devMode.value ? `NH Shelfie ${version.value}\n${r.diagnostics}` : undefined,
    })
  } catch (err) {
    toast(errText(toAppError(err)))
  } finally {
    testing.value = false
    refreshLog()
  }
}

async function doResetVerification() {
  try {
    await resetVerification()
    toast(t('settings.verificationReset'))
  } catch (err) {
    toast(errText(toAppError(err)))
  }
}

// 關於 → 版本：1.5 秒內連點 7 次切換開發者模式
let tapCount = 0
let lastTapAt = 0
async function onVersionTap() {
  const now = Date.now()
  tapCount = now - lastTapAt < 1500 ? tapCount + 1 : 1
  lastTapAt = now
  if (tapCount < 7) return
  tapCount = 0
  const on = !devMode.value
  await setSetting('dev_mode', on ? '1' : '0')
  toast(t(on ? 'settings.devModeOn' : 'settings.devModeOff'))
}

async function saveEndpoints() {
  const checks = [
    ['endpoint_detail', ['id']],
    ['endpoint_cdn', []],
    ['endpoint_page', ['id']],
  ]
  for (const [k, req] of checks) {
    if (!validateEndpointTemplate(ep[k], req)) {
      toast(errText(new AppError(E.ENDPOINT_INVALID)), 3000)
      return
    }
  }
  const changedToForeign = checks.some(([k]) => {
    try {
      const host = new URL(ep[k].replace(/\{(\w+)\}/g, '0')).hostname
      return !(host === 'nhentai.net' || host.endsWith('.nhentai.net'))
    } catch {
      return true
    }
  })
  if (changedToForeign) {
    const ok = await confirmDialog(t('settings.endpointWarning'), { danger: true })
    if (!ok) return
  }
  for (const [k] of checks) await setSetting(k, ep[k].trim())
  toast(t('settings.saved'))
}

async function restoreEndpoints() {
  await resetEndpoints()
  for (const k of Object.keys(DEFAULT_ENDPOINTS)) ep[k] = settings[k]
  toast(t('settings.saved'))
}
</script>
