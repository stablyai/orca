import { useShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import {
  type BrowserReloadState,
  resolveBrowserReloadButtonLabelKind
} from './browser-reload-action'

/** The reload button's Stop/Retry/Reload label and menu shortcuts, shared by every page toolbar. */
export function useBrowserReloadControlLabels(state: BrowserReloadState): {
  reloadButtonLabel: string
  reloadButtonLabelKind: ReturnType<typeof resolveBrowserReloadButtonLabelKind>
  reloadShortcut: string
  hardReloadShortcut: string
} {
  const t = useTranslate()
  const reloadShortcut = useShortcutLabel('browser.reload')
  const hardReloadShortcut = useShortcutLabel('browser.hardReload')
  const reloadButtonLabelKind = resolveBrowserReloadButtonLabelKind(state)
  const reloadButtonLabel =
    reloadButtonLabelKind === 'stop'
      ? t('auto.components.browser.pane.BrowserPane.b7e4d9c1a2', 'Stop')
      : reloadButtonLabelKind === 'retry'
        ? t('auto.components.browser.pane.BrowserPane.781d6459ad', 'Retry')
        : t('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')
  return { reloadButtonLabel, reloadButtonLabelKind, reloadShortcut, hardReloadShortcut }
}
