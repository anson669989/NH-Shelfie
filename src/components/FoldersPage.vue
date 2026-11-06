<template>
  <section class="page folders-page">
    <header class="folder-bar">
      <div class="folder-tabs" role="tablist">
        <button class="chip" :class="{ on: current === 'all' }" @click="select('all')">
          {{ t('folder.all') }} <small>{{ countAll }}</small>
        </button>
        <button class="chip" :class="{ on: current === 'uncat' }" @click="select('uncat')">
          {{ t('folder.uncat') }} <small>{{ countUncat }}</small>
        </button>
        <button
          v-for="f in folders"
          :key="f.id"
          v-longpress="() => folderMenu(f)"
          class="chip"
          :class="{ on: current === f.id }"
          @click="select(f.id)"
        >
          {{ f.name }}
        </button>
        <button class="chip add" :aria-label="t('folder.new')" @click="newFolder">＋</button>
      </div>
      <select class="sort-select" :value="sortMode" @change="changeSort($event.target.value)">
        <option v-for="m in SORT_MODES" :key="m" :value="m">{{ t('sort.' + m) }}</option>
      </select>
    </header>

    <div v-if="loaded && !books.length" class="empty">
      <p>{{ t('folder.empty') }}</p>
      <p class="muted">{{ t('folder.emptyHint') }}</p>
    </div>
    <CoverGrid
      v-else
      ref="grid"
      :books="books"
      :columns="Number(settings.grid_columns) || 3"
      @open="openBook"
      @longpress="bookMenu"
    />
  </section>
</template>

<script setup>
import { ref, watch } from 'vue'
import { Browser } from '@capacitor/browser'
import CoverGrid from './CoverGrid.vue'
import {
  dataVersion,
  listBooks,
  listFolders,
  counts,
  getSortMode,
  setSortMode,
  SORT_MODES,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  getBookFolders,
  addBookToFolders,
  removeBookFromFolder,
  deleteBook,
  refetchCover,
  openUrlFor,
} from '../services/library.js'
import { settings } from '../services/settings.js'
import { t, errText } from '../i18n.js'
import { actionSheet, confirmDialog, promptDialog, checklistDialog, toast } from '../ui.js'

const props = defineProps({ active: Boolean })

const folders = ref([])
const books = ref([])
const current = ref('all')
const sortMode = ref('added_desc')
const countAll = ref(0)
const countUncat = ref(0)
const loaded = ref(false)
const grid = ref(null)

async function reload() {
  folders.value = await listFolders()
  if (typeof current.value === 'number' && !folders.value.some((f) => f.id === current.value)) current.value = 'all'
  sortMode.value = await getSortMode(current.value)
  books.value = await listBooks(current.value, sortMode.value)
  const c = await counts()
  countAll.value = c.all
  countUncat.value = c.uncat
  loaded.value = true
}

watch(
  () => [props.active, dataVersion.value],
  ([active]) => {
    if (active) reload().catch((e) => toast(errText(e)))
  },
  { immediate: true },
)

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
    ...(idx > 0 ? [{ label: t('folder.moveLeft'), value: 'left' }] : []),
    ...(idx < folders.value.length - 1 ? [{ label: t('folder.moveRight'), value: 'right' }] : []),
    { label: t('folder.delete'), value: 'delete', danger: true },
  ])
  try {
    if (action === 'rename') {
      await promptDialog(t('folder.rename'), {
        value: f.name,
        placeholder: t('folder.namePlaceholder'),
        validate: (v) => renameFolder(f.id, v),
      })
    } else if (action === 'left') await moveFolder(f.id, -1)
    else if (action === 'right') await moveFolder(f.id, 1)
    else if (action === 'delete') {
      const ok = await confirmDialog(t('folder.deleteConfirm', { name: f.name }), {
        okText: t('common.delete'),
        danger: true,
      })
      if (ok) await deleteFolder(f.id)
    }
  } catch (err) {
    toast(errText(err))
  }
}

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

async function bookMenu(book) {
  const inFolders = await getBookFolders(book.gallery_id)
  const currentFolder = typeof current.value === 'number' ? folders.value.find((f) => f.id === current.value) : null
  const action = await actionSheet(`#${book.gallery_id}${book.title ? ' ' + book.title : ''}`, [
    { label: t('book.open'), value: 'open' },
    { label: t('book.addToFolder'), value: 'folders' },
    ...(currentFolder ? [{ label: t('book.removeFromFolder', { name: currentFolder.name }), value: 'remove' }] : []),
    { label: t('book.refetch'), value: 'refetch' },
    { label: t('book.delete'), value: 'delete', danger: true },
  ])
  try {
    if (action === 'open') await openBook(book)
    else if (action === 'folders') {
      const before = inFolders.map((f) => f.id)
      const picked = await checklistDialog(
        t('book.addToFolder'),
        folders.value.map((f) => ({ label: f.name, value: f.id })),
        before,
        {
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
        },
      )
      if (picked) {
        const toAdd = picked.filter((id) => !before.includes(id))
        const toRemove = before.filter((id) => !picked.includes(id))
        await addBookToFolders(book.gallery_id, toAdd)
        for (const id of toRemove) await removeBookFromFolder(book.gallery_id, id)
      }
    } else if (action === 'remove') await removeBookFromFolder(book.gallery_id, currentFolder.id)
    else if (action === 'refetch') {
      toast(t('settings.queueRunning'))
      await refetchCover(book.gallery_id)
      toast('✓')
    } else if (action === 'delete') {
      const ok = await confirmDialog(t('book.deleteConfirm', { id: book.gallery_id }), {
        okText: t('common.delete'),
        danger: true,
      })
      if (ok) await deleteBook(book.gallery_id)
    }
  } catch (err) {
    toast(errText(err))
  }
}
</script>
