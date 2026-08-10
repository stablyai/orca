import { i18n } from '@/i18n/i18n'

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
