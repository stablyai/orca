import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { TerminalClipboardPasteResult } from '../../clipboard/terminal-clipboard-paste'

/** Main cannot read CF_HDROP-only Windows copies (e.g. Zoom); a native paste event lists their files for the pane's paste listener. */
export function requestNativePasteForUnreadWindowsClipboard(
  result: TerminalClipboardPasteResult,
  pane: ManagedPane
): void {
  if (
    result.status === 'skipped' &&
    result.reason === 'empty' &&
    getShortcutPlatform() === 'win32' &&
    // Web clients cannot resolve file paths, and execCommand('paste') may prompt (Firefox).
    !isWebClientLocation() &&
    document.activeElement === pane.terminal.textarea
  ) {
    window.api.ui.performNativePaste()
  }
}
