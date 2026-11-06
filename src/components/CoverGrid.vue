<template>
  <!-- 虛擬捲動封面牆：只渲染可視範圍上下幾列，應付上千張封面 -->
  <div ref="scroller" class="grid-scroller" @scroll.passive="onScroll">
    <div class="grid-spacer" :style="{ height: totalHeight + 'px' }">
      <div
        v-for="item in visible"
        :key="item.book.gallery_id"
        v-longpress="() => emit('longpress', item.book)"
        class="cover-cell"
        :class="{ selecting, selected: isSelected(item.book) }"
        :style="{
          transform: `translate(${item.x}px, ${item.y}px)`,
          width: cellW + 'px',
          height: cellH + 'px',
        }"
        @click="selecting ? emit('toggle', item.book) : emit('open', item.book)"
      >
        <div class="cover-box" :style="{ height: coverH + 'px' }">
          <img
            v-if="srcOf(item.book) && !broken[item.book.gallery_id]"
            :src="srcOf(item.book)"
            loading="lazy"
            decoding="async"
            draggable="false"
            alt=""
            @error="broken[item.book.gallery_id] = true"
          />
          <div v-else class="cover-placeholder" :class="'st-' + phKind(item.book)">
            <span v-if="phKind(item.book) === 'loading'" class="ph-spinner" aria-hidden="true" />
            <span class="ph-text">{{ phText(item.book) }}</span>
          </div>
          <div class="cover-id">#{{ item.book.gallery_id }}</div>
          <button
            v-if="!selecting"
            class="cover-menu"
            :aria-label="t('book.menu')"
            @click.stop="emit('menu', item.book)"
            @touchstart.stop
            @mousedown.stop
          >
            <span aria-hidden="true">⋮</span>
          </button>
          <span v-if="selecting" class="cover-check" aria-hidden="true">{{ isSelected(item.book) ? '✓' : '' }}</span>
        </div>
        <div class="cover-title">{{ item.book.title }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { coverSrc } from '../services/library.js'
import { t } from '../i18n.js'
import { statusKey, isLoadingStatus } from './bookStatus.js'

const props = defineProps({
  books: { type: Array, required: true },
  columns: { type: Number, default: 3 },
  selecting: { type: Boolean, default: false },
  selectedIds: { type: Set, default: () => new Set() },
})
const emit = defineEmits(['open', 'longpress', 'toggle', 'menu'])

const GAP = 6
const RATIO = 1.42 // 封面高寬比
const TITLE_H = 36 // 書名固定兩行（12px × 行高 1.35 × 2 + 上下留白），每列一樣高
const BUFFER_ROWS = 3

const scroller = ref(null)
const width = ref(0)
const viewH = ref(0)
const scrollTop = ref(0)
const broken = reactive({})

const cols = computed(() => Math.max(2, Math.min(6, props.columns)))
const cellW = computed(() => Math.max(1, (width.value - GAP * (cols.value + 1)) / cols.value))
const coverH = computed(() => cellW.value * RATIO)
const cellH = computed(() => coverH.value + TITLE_H)
const rowH = computed(() => cellH.value + GAP)
const rows = computed(() => Math.ceil(props.books.length / cols.value))
const totalHeight = computed(() => rows.value * rowH.value + GAP)

const visible = computed(() => {
  if (!width.value) return []
  const first = Math.max(0, Math.floor(scrollTop.value / rowH.value) - BUFFER_ROWS)
  const last = Math.min(rows.value - 1, Math.ceil((scrollTop.value + viewH.value) / rowH.value) + BUFFER_ROWS)
  const out = []
  for (let r = first; r <= last; r++) {
    for (let c = 0; c < cols.value; c++) {
      const i = r * cols.value + c
      if (i >= props.books.length) break
      out.push({ book: props.books[i], x: GAP + c * (cellW.value + GAP), y: GAP + r * rowH.value })
    }
  }
  return out
})

const isSelected = (book) => props.selectedIds.has(book.gallery_id)

function srcOf(book) {
  return coverSrc(book)
}

/** 佔位圖：載入中（轉圈）、找不到、資料失敗、封面失敗 */
function phKind(book) {
  return isLoadingStatus(book) ? 'loading' : book.fetch_status === 'not_found' ? 'notfound' : 'failed'
}
function phText(book) {
  return t(statusKey(book))
}

let raf = 0
function onScroll() {
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => (scrollTop.value = scroller.value?.scrollTop || 0))
}

let ro = null
onMounted(() => {
  ro = new ResizeObserver(() => {
    width.value = scroller.value?.clientWidth || 0
    viewH.value = scroller.value?.clientHeight || 0
  })
  ro.observe(scroller.value)
})
onBeforeUnmount(() => ro?.disconnect())

// 換封面（cover_rev 變動）時清掉壞圖標記
watch(
  () => props.books,
  () => {
    for (const k of Object.keys(broken)) delete broken[k]
  },
)

defineExpose({
  scrollToTop() {
    if (scroller.value) scroller.value.scrollTop = 0
  },
})
</script>
