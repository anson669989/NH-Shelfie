// 在 `npx cap add android` 之後執行，把架構文件中的 Android 端設定套進產生出來的專案。
// 可重複執行（每一步都先檢查是否已套用）。
//
// 1. 關閉 allowBackup（換機改用 CSV）
// 2. network security config：全域禁止明文傳輸
// 3. app/build.gradle：由環境變數注入 versionCode / versionName 與 release 簽章
// 4. App 圖示：以 scripts/gen-icons.mjs 產生（取代 Capacitor 預設圖示）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateIcons } from './gen-icons.mjs'

const root = process.cwd()
const appDir = join(root, 'android', 'app')
if (!existsSync(appDir)) {
  console.error('找不到 android/app，請先執行 `npx cap add android`')
  process.exit(1)
}

// ---------- 1 & 2. AndroidManifest.xml ----------
const manifestPath = join(appDir, 'src', 'main', 'AndroidManifest.xml')
let manifest = readFileSync(manifestPath, 'utf8')

manifest = manifest.replace(/android:allowBackup="true"/, 'android:allowBackup="false"')
if (!manifest.includes('android:allowBackup=')) {
  manifest = manifest.replace('<application', '<application\n        android:allowBackup="false"')
}
if (!manifest.includes('android:networkSecurityConfig')) {
  manifest = manifest.replace(
    '<application',
    '<application\n        android:networkSecurityConfig="@xml/network_security_config"\n        android:usesCleartextTraffic="false"',
  )
}
if (!manifest.includes('android:fullBackupContent')) {
  manifest = manifest.replace('<application', '<application\n        android:fullBackupContent="false"')
}
writeFileSync(manifestPath, manifest)
console.log('✔ AndroidManifest.xml 已更新')

const xmlDir = join(appDir, 'src', 'main', 'res', 'xml')
mkdirSync(xmlDir, { recursive: true })
writeFileSync(
  join(xmlDir, 'network_security_config.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- 只允許 HTTPS；不信任使用者自行安裝的憑證 -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`,
)
console.log('✔ network_security_config.xml 已寫入')

// ---------- 3. app/build.gradle ----------
const gradlePath = join(appDir, 'build.gradle')
let gradle = readFileSync(gradlePath, 'utf8')
const MARK = '// >>> nh-collection ci config'
if (!gradle.includes(MARK)) {
  gradle += `

${MARK}
// 由 GitHub Action 注入：VERSION_CODE（遞增整數）、VERSION_NAME（如 1.2.0）
// 以及 release 簽章（ANDROID_KEYSTORE_PATH 等）。本機未設定時沿用預設值。
def ciVersionCode = System.getenv("VERSION_CODE")
def ciVersionName = System.getenv("VERSION_NAME")
android {
    defaultConfig {
        if (ciVersionCode) { versionCode ciVersionCode.toInteger() }
        if (ciVersionName) { versionName ciVersionName }
    }
}
def ksPath = System.getenv("ANDROID_KEYSTORE_PATH")
if (ksPath) {
    android {
        signingConfigs {
            ciRelease {
                storeFile file(ksPath)
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.ciRelease
            }
        }
    }
}
// <<< nh-collection ci config
`
  writeFileSync(gradlePath, gradle)
  console.log('✔ app/build.gradle 已加入 CI 版本號與簽章設定')
} else {
  console.log('• app/build.gradle 已有 CI 設定，略過')
}

// ---------- 4. App 圖示 ----------
const resDir = join(appDir, 'src', 'main', 'res')
console.log('✔ App 圖示已產生：', generateIcons(resDir).join(', '))
