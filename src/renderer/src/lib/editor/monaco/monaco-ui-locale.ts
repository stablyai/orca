import { i18n } from '@/i18n/i18n'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'

// Monaco ships its own UI strings (editor menus, find widget, peek views) as one pack per language. A pack sets
// globalThis._VSCODE_NLS_MESSAGES, and Monaco registers its actions with those strings while its modules run, so the
// pack must be in place before the first Monaco module evaluates. Keys are the renderer's UI locales.
// Monaco 0.55's pt-br pack has no translations yet, so Portuguese stays English until a Monaco upgrade ships them.
export const MONACO_UI_LOCALE_PACKS: Record<string, () => Promise<unknown>> = {
  zh: () => import('monaco-editor/esm/nls.messages.zh-cn.js'),
  'zh-Hant': () => import('monaco-editor/esm/nls.messages.zh-tw.js'),
  ko: () => import('monaco-editor/esm/nls.messages.ko.js'),
  ja: () => import('monaco-editor/esm/nls.messages.ja.js'),
  es: () => import('monaco-editor/esm/nls.messages.es.js'),
  fr: () => import('monaco-editor/esm/nls.messages.fr.js'),
  pt: () => import('monaco-editor/esm/nls.messages.pt-br.js'),
  ru: () => import('monaco-editor/esm/nls.messages.ru.js'),
  tr: () => import('monaco-editor/esm/nls.messages.tr.js'),
  de: () => import('monaco-editor/esm/nls.messages.de.js')
}

// The language settles asynchronously at boot (a native lookup with its own timeout), so a surface opened right
// after launch waits for it; past this long the editor opens in English rather than not at all.
const LANGUAGE_WAIT_MS = 3000
// A local pack arrives in milliseconds; this leaves room for a web client fetching the largest pack from its server.
const PACK_WAIT_MS = 5000

function waitForUiLanguage(): Promise<void> {
  if (useLanguageReadiness.getState().ready) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(finish, LANGUAGE_WAIT_MS)
    const unsubscribe = useLanguageReadiness.subscribe((state) => {
      if (state.ready) {
        finish()
      }
    })
  })
}

/** Waits for a pack at most `timeoutMs`; a failed or late pack leaves Monaco on its English strings. */
export async function loadMonacoUiLocalePack(
  loadPack: () => Promise<unknown>,
  timeoutMs: number = PACK_WAIT_MS
): Promise<void> {
  const previous = {
    messages: globalThis._VSCODE_NLS_MESSAGES,
    language: globalThis._VSCODE_NLS_LANGUAGE
  }
  let missedBound = false
  const loaded = loadPack().then(
    () => {
      // Why: Monaco reads the pack on every lookup, so one landing after the editor opened in English would mix languages.
      if (missedBound) {
        globalThis._VSCODE_NLS_MESSAGES = previous.messages
        globalThis._VSCODE_NLS_LANGUAGE = previous.language
      }
      return true
    },
    () => false
  )
  if (!(await withTimeout(loaded, timeoutMs, false))) {
    missedBound = true
  }
}

let installation: Promise<void> | undefined

/** Installs Monaco's pack for the UI language once per page load; a language switch applies to Monaco after a restart. */
export function installMonacoUiLocale(): Promise<void> {
  installation ??= (async () => {
    await waitForUiLanguage()
    const loadPack = MONACO_UI_LOCALE_PACKS[i18n.language]
    if (loadPack) {
      await loadMonacoUiLocalePack(loadPack)
    }
  })()
  return installation
}

/** Wrap a lazy import that evaluates Monaco so its menus and widgets come up in the UI language. */
export async function loadAfterMonacoUiLocale<T>(load: () => Promise<T>): Promise<T> {
  await installMonacoUiLocale()
  return load()
}
