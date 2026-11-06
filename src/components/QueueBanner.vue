<template>
  <!-- 背景佇列提示：429 暫停、網路重試、需要驗證、需要處理的錯誤 -->
  <div v-if="message" class="queue-banner" :class="kind">
    <span class="qb-text">{{ message }}</span>
    <button v-if="kind === 'challenge'" class="btn text" :disabled="busy" @click="verify">
      {{ t('challenge.verify') }}
    </button>
    <button v-else-if="kind === 'error'" class="btn text" @click="retry">{{ t('common.retry') }}</button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { queueState, pendingCount, runQueue, verifyChallenge } from '../services/library.js'
import { AppError, toAppError } from '../services/errors.js'
import { t, errText } from '../i18n.js'
import { toast } from '../ui.js'

const props = defineProps({ showProgress: { type: Boolean, default: false } })

const now = ref(Date.now())
const busy = ref(false)
let timer = null
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 1000)))
onBeforeUnmount(() => clearInterval(timer))

const waitSec = computed(() =>
  Math.max(0, Math.ceil((Math.max(queueState.apiWaitUntil, queueState.imgWaitUntil) - now.value) / 1000)),
)
const netSec = computed(() => Math.max(0, Math.ceil((queueState.netWaitUntil - now.value) / 1000)))

const kind = computed(() => {
  if (queueState.error) return 'error'
  if (queueState.challenge) return 'challenge'
  if (waitSec.value > 0) return 'rate'
  if (netSec.value > 0 && pendingCount.value > 0) return 'net'
  if (props.showProgress && pendingCount.value > 0) return 'progress'
  return ''
})

const message = computed(() => {
  switch (kind.value) {
    case 'error':
      return errText(new AppError(queueState.error))
    case 'challenge':
      return t('queue.challenge')
    case 'rate':
      return t('queue.rateLimited', { sec: waitSec.value })
    case 'net':
      return t('queue.offline', { sec: netSec.value })
    case 'progress':
      return t('queue.progress', { n: pendingCount.value })
    default:
      return ''
  }
})

async function verify() {
  if (busy.value) return
  busy.value = true
  try {
    const passed = await verifyChallenge({ title: t('challenge.title'), closeLabel: t('common.close') })
    if (!passed) toast(t('challenge.notPassed'))
  } catch (err) {
    toast(errText(toAppError(err)))
  } finally {
    busy.value = false
  }
}

function retry() {
  runQueue()
}
</script>
