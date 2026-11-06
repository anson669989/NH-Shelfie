<template>
  <section class="page folders-page">
    <!-- 多選模式的上方列 -->
    <header v-if="selecting" class="folder-bar select-bar">
      <button class="btn text" @click="exitSelect">{{ t('common.cancel') }}</button>
      <span class="select-count">{{ t('select.count', { n: selected.size }) }}</span>
      <button class="btn text" @click="selectAll">
        {{ allSelected ? t('select.none') : t('select.all') }}
      </button>
    </header>
    <header v-else class="folder-bar">
      <button class="select-like folder-select" :aria-label="t('folder.pick')" @click="openPicker">
        <span class="folder-select-name">{{ currentName }}</span>
        <small class="muted">({{ currentCount }})</small>
        <span class="caret">▾</span>
      </button>
      <select class="sort-select" :value="sortMode" @change="changeSort($event.target.value)">
        <option v-for="m in SORT_MODES" :key="m" :value="m">{{ t('sort.' + m) }}</option>
      </select>
    </header>

    <QueueBanner />

    <div v-if="loaded && !books.length" class="empty">
      <p>{{ t('folder.empty') }}</p>
      <p class="muted">{{ t('folder.emptyHint') }}</p>
    </div>
    <CoverGrid
      v-else
      ref="grid"
      :books="books"
      :columns="Number(settings.grid_columns) || 3"
      :selecting="selecting"
      :selected-ids="selected"
      @open="openBook"
      @longpress="startSelect"
      @toggle="toggle"
      @menu="bookMenu"
    />

    <!-- 多選模式的下方動作列 -->
    <footer v-if="selecting" class="select-actions">
      <button class="select-action" :disabled="!selected.size" @click="batchClassify">
        <span class="sa-icon" aria-hidden="true">📁</span>{{ t('select.classify') }}
      </button>
      <button v-if="currentFolder" class="select-action" :disabled="!selected.size" @click="batchRemove">
        <span class="sa-icon" aria-hidden="true">➖</span>{{ t('select.removeFromFolder') }}
      </button>
      <button class="select-action danger" :disabled="!selected.size" @click="batchDelete">
        <span class="sa-icon" aria-hidden="true">🗑</span>{{ t('select.delete') }}
      </button>
    </footer>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Browser } from '@capacitor/browser'
import CoverGrid from './CoverGrid.vue'
import QueueBanner from './QueueBanner.vue'
import {
  dataVersion,
  listBooks,
  listFolders,
  folderCounts,
  getSortMode,
  setSortMode,
  SORT_MODES,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  getBookFolders,
  getBookTitles,
  addBooksToFolders,
  setBookFolders,
  removeBooksFromFolder,
  deleteBooks,
  requeueBook,
  changeBookId,
  openUrlFor,
} from '../services/library.js'
import { parseGalleryId } from '../services/parse.js'
import { AppError, E } from '../services/errors.js'
import { settings } from '../services/settings.js'
import { t, errText } from '../i18n.js'
import { actionSheet, confirmDialog, promptDialog, checklistDialog, toast, pushBackHandler } from '../ui.js'

const props = defineProps({ active: Boolean })

const folders = ref([])
const books = ref([])
const current = ref('all')
const sortMode = ref('added_desc')
const counts = ref({ all: 0, uncat: 0, byFolder: {} })
const loaded = ref(false)
const grid = ref(null)

// ---- 多選模式 ----
const selecting = ref(false)
const selected = ref(new Set())
let removeBack = null

const countOf = (key) =>
  key === 'all' ? counts.value.all : key === 'uncat' ? counts.value.uncat : counts.value.byFolder[key] || 0
/** 目前所在的自建資料夾；「全部」「未分類」為 null（預設資料夾不顯示「從此資料夾移除」） */
const currentFolder = computed(() =>
  typeof current.value === 'number' ? folders.value.find((f) => f.id === current.value) || null : null,
)
const currentName = computed(() =>
  current.value === 'all' ? t('folder.all') : current.value === 'uncat' ? t('folder.uncat') : currentFolder.value?.name || '',
)
const currentCount = computed(() => countOf(current.value))
const allSelected = computed(() => books.value.length > 0 && selected.value.size === books.value.length)

async function reload() {
  folders.value = await listFolders()
  if (typeof current.value === 'number' && !folders.value.some((f) => f.id === current.value)) {
    current.value = 'all' // 目前所在的資料夾被刪除 → 回到「全部」
    grid.value?.scrollToTop?.()
  }
  sortMode.value = await getSortMode(current.value)
  books.value = await listBooks(current.value, sortMode.value)
  counts.value = await folderCounts()
  loaded.value = true
  if (selecting.value) {
    // 已不在列表中的書（被刪除、被移出）從選取中拿掉
    const ids = new Set(books.value.map((b) => b.gallery_id))
    selected.value = new Set([...selected.value].filter((id) => ids.has(id)))
  }
}

watch(
  () => [props.active, dataVersion.value],
  ([active]) => {
    if (active) reload().catch((e) => toast(errText(e)))
    else exitSelect()
  },
  { immediate: true },
)

function startSelect(book) {
  if (!selecting.value) {
    selecting.value = true
    selected.value = new Set()
    removeBack = pushBackHandler(exitSelect) // 返回鍵先退出多選模式
  }
  toggle(book, true)
}

function toggle(book, forceOn = false) {
  const s = new Set(selected.value)
  if (s.has(book.gallery_id) && !forceOn) s.delete(book.gallery_id)
  else s.add(book.gallery_id)
  selected.value = s
}

function selectAll() {
  selected.value = allSelected.value ? new Set() : new Set(books.value.map((b) => b.gallery_id))
}

function exitSelect() {
  selecting.value = false
  selected.value = new Set()
  removeBack?.()
  removeBack = null
}

async function pickFoldersDialog(title, items, preselected = []) {
  return checklistDialog(title, items, preselected, {
    extraAction: {
      label: '＋ ' + t('folder.new'),
      run: async () => {
        let id = null
        const name = await promptDialog(t('folder.new'), {
          placeholder: t('folder.namePlaceholder'),
          validate: async (v) => {
            id = await createFolder(v)
          },
        })
        return name != null && id ? { label: name.trim(), value: id } : null
      },
    },
  })
}

async function batchClassify() {
  const ids = [...selected.value]
  const others = folders.value.filter((f) => f.id !== current.value)
  const picked = await pickFoldersDialog(
    t('select.classifyTitle', { n: ids.length }),
    others.map((f) => ({ label: f.name, value: f.id })),
  )
  if (!picked?.length) return
  try {
    await addBooksToFolders(ids, picked)
    toast(t('select.classified', { n: ids.length, f: picked.length }))
    exitSelect()
  } catch (err) {
    toast(errText(err))
  }
}

async function batchRemove() {
  const ids = [...selected.value]
  const f = currentFolder.value
  if (!f) return
  try {
    await removeBooksFromFolder(ids, f.id)
    toast(t('select.removed', { n: ids.length }))
    exitSelect()
  } catch (err) {
    toast(errText(err))
  }
}

async function batchDelete() {
  const ids = [...selected.value]
  const ok = await confirmDialog(t('select.deleteConfirm', { n: ids.length }), {
    okText: t('common.delete'),
    danger: true,
  })
  if (!ok) return
  try {
    await deleteBooks(ids)
    toast(t('select.deleted', { n: ids.length }))
    exitSelect()
  } catch (err) {
    toast(errText(err))
  }
}

// ---- 資料夾選單 ----
async function openPicker() {
  const row = (key, label) => ({ label: `${label} (${countOf(key)})`, value: key, checked: current.value === key })
  const action = await actionSheet(
    t('folder.pick'),
    [
      row('all', t('folder.all')),
      row('uncat', t('folder.uncat')),
      { divider: true },
      ...folders.value.map((f) => ({ ...row(f.id, f.name), more: true })),
      ...(folders.value.length ? [{ divider: true }] : []),
      { label: '＋ ' + t('folder.new'), value: '__new' },
    ],
    { tall: true },
  )
  if (action === false || action == null) return
  if (action === '__new') return newFolder()
  if (typeof action === 'object' && 'more' in action) {
    const f = folders.value.find((x) => x.id === action.more)
    if (f && (await folderMenu(f))) openPicker() // 管理完回到選單，方便連續操作
    return
  }
  select(action)
}

async function select(key) {
  current.value = key
  await reload()
  grid.value?.scrollToTop?.()
}

async function changeSort(mode) {
  await setSortMode(current.value, mode)
  await reload()
}

async function newFolder() {
  let newId = null
  const name = await promptDialog(t('folder.new'), {
    placeholder: t('folder.namePlaceholder'),
    validate: async (v) => {
      newId = await createFolder(v)
    },
  })
  if (name != null && newId) select(newId)
}

async function folderMenu(f) {
  const idx = folders.value.findIndex((x) => x.id === f.id)
  const action = await actionSheet(f.name, [
    { label: t('folder.rename'), value: 'rename' },
    ...(idx > 0 ? [{ label: t('folder.moveUp'), value: 'up' }] : []),
    ...(idx < folders.value.length - 1 ? [{ label: t('folder.moveDown'), value: 'down' }] : []),
    { label: t('folder.delete'), value: 'delete', danger: true },
  ])
  if (!action) return false
  try {
    if (action === 'rename') {
      await promptDialog(t('folder.rename'), {
        value: f.name,
        placeholder: t('folder.namePlaceholder'),
        validate: (v) => renameFolder(f.id, v),
      })
    } else if (action === 'up') await moveFolder(f.id, -1)
    else if (action === 'down') await moveFolder(f.id, 1)
    else if (action === 'delete') {
      const ok = await confirmDialog(t('folder.deleteConfirm', { name: f.name }), {
        okText: t('common.delete'),
        danger: true,
      })
      if (ok) await deleteFolder(f.id)
    }
    await reload() // 先更新清單與本數，再讓呼叫端重開選單
  } catch (err) {
    toast(errText(err))
  }
  return true
}

// ---- 單本 ----
async function openBook(book) {
  let url
  try {
    url = openUrlFor(book.gallery_id)
    await Browser.open({ url })
  } catch (err) {
    if (!url) {
      toast(errText(err))
      return
    }
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      /* ignore */
    }
    toast(t('common.copied'))
  }
}

async function copyId(id) {
  try {
    await navigator.clipboard.writeText(String(id))
    toast(t('book.idCopied', { id }))
  } catch {
    toast(t('common.copyFailed'))
  }
}

/** 封面右上角「⋮」：完整標題＋單本功能 */
async function bookMenu(book) {
  const id = book.gallery_id
  let titles = { english: '', japanese: '', pretty: book.title }
  try {
    titles = await getBookTitles(id)
  } catch {
    /* 讀不到就只顯示簡短標題 */
  }
  const lines = [titles.english || titles.pretty, titles.japanese].filter((v, i, a) => v && a.indexOf(v) === i)
  const notFound = book.fetch_status === 'not_found'
  const f = currentFolder.value
  const action = await actionSheet(
    `#${id}`,
    [
      { label: t('book.copyId'), value: 'copy' },
      ...(notFound ? [{ label: t('book.changeId'), value: 'changeId' }] : [{ label: t('book.open'), value: 'open' }]),
      { label: t('book.classify'), value: 'folders' },
      ...(f ? [{ label: t('book.removeFromFolder', { name: f.name }), value: 'remove' }] : []),
      ...(notFound ? [] : [{ label: t('book.refetch'), value: 'refetch' }]),
      { label: t('book.delete'), value: 'delete', danger: true },
    ],
    { lines },
  )
  try {
    if (action === 'copy') await copyId(id)
    else if (action === 'open') await openBook(book)
    else if (action === 'changeId') await changeId(book)
    else if (action === 'folders') {
      const before = (await getBookFolders(id)).map((x) => x.id)
      const picked = await pickFoldersDialog(
        t('book.classify'),
        folders.value.map((x) => ({ label: x.name, value: x.id })),
        before,
      )
      if (picked) await setBookFolders(id, picked)
    } else if (action === 'remove') {
      await removeBooksFromFolder([id], f.id)
      toast(t('select.removed', { n: 1 }))
    } else if (action === 'refetch') {
      await requeueBook(id)
      toast(t('book.requeued'))
    } else if (action === 'delete') {
      const ok = await confirmDialog(t('book.deleteConfirm', { id }), { okText: t('common.delete'), danger: true })
      if (ok) await deleteBooks([id])
    }
  } catch (err) {
    toast(errText(err))
  }
}

async function changeId(book) {
  await promptDialog(t('book.changeId'), {
    value: String(book.gallery_id),
    placeholder: t('add.placeholder'),
    maxlength: 60,
    validate: async (v) => {
      const n = parseGalleryId(v)
      if (!n) throw new AppError(E.INVALID_ID)
      await changeBookId(book.gallery_id, n)
    },
  })
}
</script>
