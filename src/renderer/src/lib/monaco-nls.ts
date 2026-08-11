import { i18n } from '@/i18n/i18n'
import { resolveUiLocale } from '@/i18n/supported-languages'
import { useAppStore } from '@/store'
import { isPluginUiLanguage, type UiLanguage } from '../../../shared/ui-language'

/**
 * Monaco reads `globalThis._VSCODE_NLS_MESSAGES` when contributions call
 * localize(), so the matching nls.messages.* module must load before
 * `monaco-editor` (or any contrib that registers labeled actions).
 */
export async function loadMonacoNlsForUiLocale(locale: string = i18n.language): Promise<void> {
  if (locale === 'zh') {
    await import('monaco-editor/esm/nls.messages.zh-cn.js')
  } else if (locale === 'ja') {
    await import('monaco-editor/esm/nls.messages.ja.js')
  } else if (locale === 'ko') {
    await import('monaco-editor/esm/nls.messages.ko.js')
  } else if (locale === 'es') {
    await import('monaco-editor/esm/nls.messages.es.js')
  }
}

// Why: settings arrive async over IPC while i18n boots in 'en'. Monaco NLS is
// evaluate-once, so the bootstrap must wait for the persisted uiLanguage before
// the first runtime `monaco-editor` import. Bounded so a missing settings
// payload cannot block the editor forever.
const SETTINGS_WAIT_MS = 5000

async function resolveStartupUiLocale(): Promise<string> {
  const readUiLanguage = (): UiLanguage | null =>
    useAppStore.getState().settings?.uiLanguage ?? null
  let uiLanguage = readUiLanguage()
  if (uiLanguage === null) {
    uiLanguage = await new Promise<UiLanguage | null>((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, SETTINGS_WAIT_MS)
      const unsubscribe = useAppStore.subscribe((state) => {
        const value = state.settings?.uiLanguage ?? null
        if (value !== null) {
          clearTimeout(timer)
          unsubscribe()
          resolve(value)
        }
      })
    })
  }
  if (uiLanguage === null) {
    return i18n.language
  }
  // Plugin language packs have no Monaco NLS pack; fall back to English labels.
  return isPluginUiLanguage(uiLanguage) ? 'en' : resolveUiLocale(uiLanguage)
}

let bootstrapPromise: Promise<void> | null = null

/**
 * Single gate for runtime Monaco evaluation: resolves the persisted UI locale,
 * then loads its NLS pack. `monaco-setup.ts` awaits this before importing
 * `monaco-editor`, so all editor surfaces share one correctly-localized boot.
 */
export function monacoNlsBootstrap(): Promise<void> {
  bootstrapPromise ??= resolveStartupUiLocale().then((locale) => loadMonacoNlsForUiLocale(locale))
  return bootstrapPromise
}
