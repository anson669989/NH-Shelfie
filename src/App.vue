<template>
  <div class="app" :class="{ dark: isDark }" :style="themeVars">
    <div v-if="initError" class="init-error">
      <p>{{ initError }}</p>
    </div>
    <template v-else-if="ready">
      <main class="pages">
        <FoldersPage v-show="tab === 'folders'" :active="tab === 'folders'" />
        <AddPage v-show="tab === 'add'" :active="tab === 'add'" />
        <SettingsPage v-show="tab === 'settings'" :active="tab === 'settings'" />
      </main>
      <nav class="bottom-nav">
        <button :class="{ on: tab === 'folders' }" @click="tab = 'folders'">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>
          <span>{{ t('nav.folders') }}</span>
        </button>
        <button class="center" :class="{ on: tab === 'add' }" @click="tab = 'add'">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          <span>{{ t('nav.add') }}</span>
        </button>
        <button :class="{ on: tab === 'settings' }" @click="tab = 'settings'">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          <span>{{ t('nav.settings') }}</span>
        </button>
      </nav>
    </template>
    <DialogHost />
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { App as CapApp } from '@capacitor/app'
import FoldersPage from './components/FoldersPage.vue'
import AddPage from './components/AddPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import DialogHost from './components/DialogHost.vue'
import { initLibrary, runQueue, stopQueue, pendingCount } from './services/library.js'
import { settings } from './services/settings.js'
import { t } from './i18n.js'
import { closeTopDialog, toast } from './ui.js'

const tab = ref('folders')
const ready = ref(false)
const initError = ref('')

const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
const systemDark = ref(mq?.matches ?? false)
const onMq = (e) => (systemDark.value = e.matches)

const isDark = computed(() =>
  settings.dark_mode === 'dark' ? true : settings.dark_mode === 'light' ? false : systemDark.value,
)
const themeVars = computed(() => ({ '--primary': settings.theme_color }))

let lastBack = 0
const listeners = []

onMounted(async () => {
  mq?.addEventListener?.('change', onMq)
  try {
    await initLibrary()
    ready.value = true
  } catch (err) {
    console.error(err)
    initError.value = `初始化失敗 / Init failed: ${err?.message || err}`
    return
  }

  listeners.push(
    await CapApp.addListener('backButton', () => {
      if (closeTopDialog()) return
      if (tab.value !== 'folders') {
        tab.value = 'folders'
        return
      }
      if (Date.now() - lastBack < 2000) {
        CapApp.exitApp()
      } else {
        lastBack = Date.now()
        toast(t('common.pressAgainToExit'))
      }
    }),
  )
  // 待抓佇列只在前景執行：切到背景就停，回到前景自動續跑
  listeners.push(
    await CapApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        if (pendingCount.value > 0) runQueue().catch(() => {})
      } else stopQueue()
    }),
  )
  if (pendingCount.value > 0) runQueue().catch(() => {})
})

onBeforeUnmount(() => {
  mq?.removeEventListener?.('change', onMq)
  listeners.forEach((l) => l.remove())
})
</script>
