import { createApp } from 'vue'
import App from './App.vue'
import { vLongpress } from './ui.js'
import './styles.css'

const app = createApp(App)
app.directive('longpress', vLongpress)
app.mount('#app')
