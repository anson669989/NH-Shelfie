// 簡單的對話框、選單與提示訊息服務（不依賴 UI 套件，外掛最少化）。
import { reactive } from 'vue'

export const ui = reactive({
  dialogs: [], // { id, kind: 'confirm'|'prompt'|'sheet'|'alert'|'checklist', ...opts, resolve }
  toast: null, // { text, id }
})

let seq = 0
function open(kind, opts) {
  return new Promise((resolve) => {
    ui.dialogs.push({ id: ++seq, kind, ...opts, resolve })
  })
}
export function closeDialog(d, value) {
  const i = ui.dialogs.indexOf(d)
  if (i >= 0) ui.dialogs.splice(i, 1)
  d.resolve(value)
}
/** 關閉最上層對話框；回傳是否有關閉（給返回鍵用） */
export function closeTopDialog() {
  const d = ui.dialogs[ui.dialogs.length - 1]
  if (!d) return false
  closeDialog(d, d.kind === 'checklist' ? null : d.kind === 'prompt' ? null : false)
  return true
}

/** @returns {Promise<boolean>} */
export const confirmDialog = (message, { okText, danger = false } = {}) =>
  open('confirm', { message, okText, danger })

export const alertDialog = (message, { title } = {}) => open('alert', { message, title })

/** @returns {Promise<string|null>} */
export const promptDialog = (title, { value = '', placeholder = '', maxlength = 30, validate } = {}) =>
  open('prompt', { title, value, placeholder, maxlength, validate, error: '' })

/**
 * 動作選單
 * @param {{label:string, value:any, danger?:boolean}[]} actions
 * @returns {Promise<any|false>}
 */
export const actionSheet = (title, actions) => open('sheet', { title, actions })

/**
 * 多選清單
 * @param {{label:string, value:any}[]} items
 * @param {any[]} selected
 * @returns {Promise<any[]|null>}
 */
export const checklistDialog = (title, items, selected = [], { extraAction } = {}) =>
  open('checklist', { title, items, selected: [...selected], extraAction })

let toastTimer = null
export function toast(text, ms = 2200) {
  ui.toast = { text, id: ++seq }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (ui.toast = null), ms)
}

/** v-longpress 指令：長按 500ms 觸發，並吞掉隨後的 click */
export const vLongpress = {
  mounted(el, binding) {
    let timer = null
    let fired = false
    let sx = 0
    let sy = 0
    const start = (e) => {
      fired = false
      const p = e.touches ? e.touches[0] : e
      sx = p.clientX
      sy = p.clientY
      clearTimeout(timer)
      timer = setTimeout(() => {
        fired = true
        if (navigator.vibrate) navigator.vibrate(15)
        binding.value?.(e)
      }, 500)
    }
    const move = (e) => {
      const p = e.touches ? e.touches[0] : e
      if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) clearTimeout(timer)
    }
    const cancel = () => clearTimeout(timer)
    const click = (e) => {
      if (fired) {
        e.stopImmediatePropagation()
        e.preventDefault()
        fired = false
      }
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    el.addEventListener('touchend', cancel)
    el.addEventListener('touchcancel', cancel)
    el.addEventListener('mousedown', start)
    el.addEventListener('mousemove', move)
    el.addEventListener('mouseup', cancel)
    el.addEventListener('mouseleave', cancel)
    el.addEventListener('click', click, true)
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el._lp = { cancel }
  },
  unmounted(el) {
    el._lp?.cancel()
  },
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
