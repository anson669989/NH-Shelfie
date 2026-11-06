<template>
  <section class="page add-page">
    <div class="add-inner">
      <!-- 1. ID 輸入框 -->
      <form class="id-row" @submit.prevent="lookup">
        <input
          ref="inputEl"
          v-model="raw"
          class="input id-input"
          type="text"
          inputmode="numeric"
          enterkeyhint="search"
          autocomplete="off"
          :placeholder="t('add.placeholder')"
          @input="onInput"
          @paste="onPaste"
        />
        <button type="submit" class="btn primary" :disabled="!parsedId || loading || !!dup">
          {{ t('add.query') }}
        </button>
      </form>
      <p v-if="raw && !parsedId" class="field-error">{{ t('err.INVALID_ID') }}</p>
      <p v-else-if="!raw" class="muted small">{{ t('add.hint') }}</p>

      <!-- 3. 重複提示（不發網路請求） -->
      <div v-if="dup" class="notice warn">
        <strong>{{ t('add.duplicate', { id: dup.book.gallery_id }) }}</strong>
        <span v-if="dup.book.title"> · {{ dup.book.title }}</span>
        <div>{{ t('add.inFolders', { names: dup.folders.length ? dup.folders.map((f) => f.name).join('、') : t('folder.uncat') }) }}</div>
      </div>

      <!-- 2. 封面預覽＋書名 -->
      <div class="preview">
        <div v-if="loading" class="preview-card skeleton">
          <div class="sk-cover" />
          <div class="sk-lines"><div /><div /><div /></div>
        </div>
        <div v-else-if="result" class="preview-card">
          <img v-if="result.cover" :src="result.cover.src" alt="" />
          <div v-else class="cover-placeholder small"><span>?</span></div>
          <div class="preview-info">
            <div class="muted">#{{ result.id }}</div>
            <div class="preview-title">{{ result.meta.title || result.meta.titleJa }}</div>
            <div v-if="result.meta.titleJa && result.meta.titleJa !== result.meta.title" class="muted small">
              {{ result.meta.titleJa }}
            </div>
            <p v-if="!result.cover" class="muted small">{{ t('add.noCoverNote') }}</p>
          </div>
        </div>
        <div v-else-if="error" class="notice error">
          <span>{{ errText(error) }}</span>
          <button
            v-if="['OFFLINE', 'TIMEOUT', 'BLOCKED', 'RATE_LIMITED'].includes(error.code)"
            class="btn text"
            :disabled="cooldown > 0"
            @click="lookup"
          >
            {{ cooldown > 0 ? `${t('common.retry')} (${cooldown})` : t('common.retry') }}
          </button>
        </div>
      </div>

      <!-- 4. 資料夾多選＋「＋」 -->
      <div class="folder-pick">
        <label class="muted small">{{ t('add.folders') }}</label>
        <div class="folder-pick-row">
          <button class="select-like" @click="pickFolders">
            {{ selectedNames || t('add.noFolder') }}
            <span class="caret">▾</span>
          </button>
          <button class="btn icon" :aria-label="t('folder.new')" @click="quickNewFolder">＋</button>
        </div>
      </div>

      <!-- 5. 加入收藏 -->
      <button class="btn primary block big" :disabled="!canSubmit" @click="submit">
        {{ saving ? t('add.saving') : dup ? t('add.addToMore') : t('add.submit') }}
      </button>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  getBook,
  getBookFolders,
  lookupGallery,
  addBook,
  addBookToFolders,
  listFolders,
  createFolder,
  dataVersion,
} from '../services/library.js'
import { parseGalleryId } from '../services/parse.js'
import { AppError, E, toAppError } from '../services/errors.js'
import { settings, setSetting } from '../services/settings.js'
import { rateLimitRemaining } from '../services/nhSource.js'
import { t, errText } from '../i18n.js'
import { checklistDialog, promptDialog, toast } from '../ui.js'

const props = defineProps({ active: Boolean })

const inputEl = ref(null)
const raw = ref('')
const loading = ref(false)
const saving = ref(false)
const result = ref(null)
const error = ref(null)
const dup = ref(null)
const folders = ref([])
const selected = ref([])
const cooldown = ref(0)
let cooldownTimer = null
let lookupSeq = 0

const parsedId = computed(() => parseGalleryId(raw.value))
const selectedNames = computed(() =>
  folders.value
    .filter((f) => selected.value.includes(f.id))
    .map((f) => f.name)
    .join('、'),
)
const canSubmit = computed(() => !saving.value && !loading.value && (!!dup.value || (!!result.value && result.value.id === parsedId.value)))

async function loadFolders() {
  folders.value = await listFolders()
  let last = []
  try {
    last = JSON.parse(settings.last_folders || '[]')
  } catch {
    last = []
  }
  // 預設記住上次選的資料夾（過濾掉已刪除的）
  if (!selected.value.length) selected.value = last.filter((id) => folders.value.some((f) => f.id === id))
  else selected.value = selected.value.filter((id) => folders.value.some((f) => f.id === id))
}

watch(
  () => [props.active, dataVersion.value],
  ([active]) => {
    if (active) {
      loadFolders()
      if (parsedId.value) checkDuplicate()
    }
  },
  { immediate: true },
)

/** 輸入時只做本機重複檢查，不上網（停頓不會自動抓取） */
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
  error.value = null
  if (result.value && result.value.id !== parsedId.value) result.value = null
  checkDuplicate()
}

function onPaste() {
  // 貼上網址：等 v-model 更新後自動取出數字並查詢
  setTimeout(async () => {
    const id = parsedId.value
    if (id) {
      raw.value = String(id)
      await checkDuplicate()
      if (!dup.value) lookup()
    }
  }, 0)
}

async function lookup() {
  const id = parsedId.value
  inputEl.value?.blur() // 收起鍵盤，避免蓋住按鈕
  if (!id) {
    error.value = new AppError(E.INVALID_ID)
    return
  }
  await checkDuplicate()
  if (dup.value) return
  if (loading.value) return
  const seq = ++lookupSeq
  loading.value = true
  error.value = null
  result.value = null
  try {
    const r = await lookupGallery(id)
    if (seq === lookupSeq) result.value = r
  } catch (err) {
    if (seq !== lookupSeq) return
    const e = toAppError(err)
    if (e.code === E.DUPLICATE) await checkDuplicate()
    else {
      error.value = e
      if (e.code === E.RATE_LIMITED) startCooldown()
    }
  } finally {
    if (seq === lookupSeq) loading.value = false
  }
}

function startCooldown() {
  cooldown.value = rateLimitRemaining() || 30
  clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value = rateLimitRemaining()
    if (cooldown.value <= 0) clearInterval(cooldownTimer)
  }, 1000)
}
onBeforeUnmount(() => clearInterval(cooldownTimer))

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
  if (picked) selected.value = picked
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
  if (added && !selected.value.includes(added.id)) selected.value = [...selected.value, added.id] // 建立後自動勾選
}

async function submit() {
  if (!canSubmit.value) return
  saving.value = true // 儲存中按鈕停用，避免連點
  try {
    if (dup.value) {
      await addBookToFolders(dup.value.book.gallery_id, selected.value)
      await checkDuplicate()
      toast(t('add.added', { id: dup.value.book.gallery_id }))
    } else {
      await addBook(result.value, selected.value)
      toast(t('add.added', { id: result.value.id }))
      result.value = null
      raw.value = ''
      dup.value = null
      await nextTick()
      inputEl.value?.focus() // 保留焦點，方便連續輸入
    }
    await setSetting('last_folders', JSON.stringify(selected.value))
  } catch (err) {
    const e = toAppError(err)
    if (e.code === E.DUPLICATE) await checkDuplicate()
    else toast(errText(e))
  } finally {
    saving.value = false
  }
}
</script>
