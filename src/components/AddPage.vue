<template>
  <section class="page add-page">
    <!-- 頂部固定：ID 輸入＋加入＋資料夾（加入只做本機動作，不等網路） -->
    <div class="add-top">
      <div class="add-inner">
        <form class="id-row" @submit.prevent="submit">
          <input
            ref="inputEl"
            v-model="raw"
            class="input id-input"
            type="text"
            inputmode="numeric"
            enterkeyhint="done"
            autocomplete="off"
            :placeholder="t('add.placeholder')"
            @input="onInput"
            @paste="onPaste"
          />
          <button type="submit" class="btn primary" :disabled="!parsedId || saving">
            {{ t('add.submit') }}
          </button>
        </form>
        <p v-if="raw && !parsedId" class="field-error">{{ t('err.INVALID_ID') }}</p>
        <div class="folder-pick">
          <div class="folder-pick-row">
            <button class="select-like" :aria-label="t('add.folders')" @click="pickFolders">
              <span class="muted small">{{ t('add.folders') }}：</span>
              <span class="folder-select-name">{{ selectedNames || t('add.noFolder') }}</span>
              <span class="caret">▾</span>
            </button>
            <button class="btn icon" :aria-label="t('folder.new')" @click="quickNewFolder">＋</button>
          </div>
        </div>
        <!-- 已收藏提示（只查本機） -->
        <div v-if="dup" class="notice warn small">
          <strong>{{ t('add.duplicate', { id: dup.book.gallery_id }) }}</strong>
          <span v-if="dup.book.title"> · {{ dup.book.title }}</span>
          <div>{{ t('add.inFolders', { names: folderNames(dup.folders) }) }}</div>
        </div>
      </div>
    </div>

    <QueueBanner show-progress />

    <!-- 最近加入：背景查到書名、封面後自動更新 -->
    <div class="add-body">
      <div class="add-inner">
        <h3 class="recent-title">{{ t('add.recent') }}</h3>
        <p v-if="!recent.length" class="add-empty muted">{{ t('add.hint') }}</p>
        <ul v-else class="recent-list">
          <li v-for="b in recent" :key="b.gallery_id" class="recent-row">
            <img v-if="b.cover_path && !broken[b.gallery_id]" :src="coverSrc(b)" alt="" @error="broken[b.gallery_id] = true" />
            <div v-else class="recent-ph" :class="{ loading: isLoadingStatus(b) }" />
            <div class="recent-info">
              <div class="muted small">#{{ b.gallery_id }}</div>
              <div v-if="b.title" class="recent-name">{{ b.title }}</div>
              <div v-else class="recent-name muted">{{ t(statusKey(b)) }}</div>
              <div v-if="b.title && b.fetch_status !== 'ok'" class="muted small">{{ t(statusKey(b)) }}</div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import QueueBanner from './QueueBanner.vue'
import {
  getBook,
  getBookFolders,
  quickAdd,
  listFolders,
  listRecentBooks,
  createFolder,
  coverSrc,
  dataVersion,
  sharedInput,
} from '../services/library.js'
import { parseGalleryId } from '../services/parse.js'
import { settings, setSetting } from '../services/settings.js'
import { t, errText } from '../i18n.js'
import { checklistDialog, promptDialog, toast } from '../ui.js'
import { statusKey, isLoadingStatus } from './bookStatus.js'

const props = defineProps({ active: Boolean })

const inputEl = ref(null)
const raw = ref('')
const saving = ref(false)
const dup = ref(null)
const folders = ref([])
const selected = ref([])
const recent = ref([])
const broken = reactive({})

const parsedId = computed(() => parseGalleryId(raw.value))
const selectedNames = computed(() =>
  folders.value
    .filter((f) => selected.value.includes(f.id))
    .map((f) => f.name)
    .join('、'),
)
const folderNames = (list) => (list.length ? list.map((f) => f.name).join('、') : t('folder.uncat'))

async function loadFolders() {
  folders.value = await listFolders()
  let last = []
  try {
    last = JSON.parse(settings.last_folders || '[]')
  } catch {
    last = []
  }
  // 記住上次選的資料夾（過濾掉已刪除的）
  if (!selected.value.length) selected.value = last.filter((id) => folders.value.some((f) => f.id === id))
  else selected.value = selected.value.filter((id) => folders.value.some((f) => f.id === id))
}

async function loadRecent() {
  recent.value = await listRecentBooks(20)
  for (const k of Object.keys(broken)) delete broken[k]
}

watch(
  () => [props.active, dataVersion.value],
  ([active]) => {
    if (!active) return
    loadFolders().catch(() => {})
    loadRecent().catch(() => {})
    if (parsedId.value) checkDuplicate()
  },
  { immediate: true },
)

// 從瀏覽器分享進來：填入 ID，資料夾維持上次的選擇，按一下「加入」即可
watch(sharedInput, async (v) => {
  if (!v) return
  if (!v.id) {
    toast(t('share.noId'))
    return
  }
  raw.value = String(v.id)
  await loadFolders()
  await checkDuplicate()
})

/** 輸入時只做本機重複檢查，不上網 */
async function checkDuplicate() {
  const id = parsedId.value
  if (!id) {
    dup.value = null
    return
  }
  const book = await getBook(id)
  if (parsedId.value !== id) return
  dup.value = book ? { book, folders: await getBookFolders(id) } : null
}

function onInput() {
  checkDuplicate()
}

function onPaste() {
  // 貼上網址或 #123456：等 v-model 更新後只留數字
  setTimeout(() => {
    const id = parsedId.value
    if (id) {
      raw.value = String(id)
      checkDuplicate()
    }
  }, 0)
}

async function pickFolders() {
  const picked = await checklistDialog(
    t('add.folders'),
    folders.value.map((f) => ({ label: f.name, value: f.id })),
    selected.value,
    {
      extraAction: {
        label: '＋ ' + t('folder.new'),
        run: async () => {
          const added = await promptNewFolder()
          return added ? { label: added.name, value: added.id } : null
        },
      },
    },
  )
  if (picked) {
    selected.value = picked
    await setSetting('last_folders', JSON.stringify(picked))
    checkDuplicate()
  }
}

async function promptNewFolder() {
  let id = null
  const name = await promptDialog(t('folder.new'), {
    placeholder: t('folder.namePlaceholder'),
    validate: async (v) => {
      id = await createFolder(v)
    },
  })
  if (name == null || !id) return null
  folders.value = await listFolders()
  return { id, name: folders.value.find((f) => f.id === id)?.name || name }
}

async function quickNewFolder() {
  const added = await promptNewFolder()
  if (added && !selected.value.includes(added.id)) {
    selected.value = [...selected.value, added.id] // 建立後自動勾選
    await setSetting('last_folders', JSON.stringify(selected.value))
  }
}

/** 「先存、後查」：只做本機動作，三種情況都立刻清空輸入框 */
async function submit() {
  const id = parsedId.value
  if (!id || saving.value) return
  const keepFocus = document.activeElement === inputEl.value
  saving.value = true
  try {
    const r = await quickAdd(id, selected.value)
    if (r.kind === 'new') toast(t('add.added', { id }))
    else if (r.kind === 'already') toast(t('add.alreadyHere', { id }))
    else toast(t('add.addedExisting', { id, names: folderNames(r.originalFolders.map((name) => ({ name }))) }))
    raw.value = ''
    dup.value = null
    await setSetting('last_folders', JSON.stringify(selected.value))
    await nextTick()
    if (keepFocus) inputEl.value?.focus() // 方便連續輸入
  } catch (err) {
    toast(errText(err))
  } finally {
    saving.value = false
  }
}
</script>
