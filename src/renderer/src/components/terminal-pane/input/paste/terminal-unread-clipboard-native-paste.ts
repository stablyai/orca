import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { translate } from '@/i18n/i18n'
import type { TerminalClipboardPasteResult } from '../../clipboard/terminal-clipboard-paste'

const PENDING_NATIVE_PASTE_TIMEOUT_MS = 1000

let pendingNativePastePane: ManagedPane | null = null
let pendingNativePasteTimerId: number | null = null

function clearPendingUnreadWindowsClipboardNativePaste(): void {
  pendingNativePastePane = null
  if (pendingNativePasteTimerId !== null) {
    window.clearTimeout(pendingNativePasteTimerId)
    pendingNativePasteTimerId = null
  }
}

/** Main cannot read CF_HDROP-only Windows copies (e.g. Zoom); a native paste event lists their files for the pane's paste listener. */
export function requestNativePasteForUnreadWindowsClipboard(
  result: TerminalClipboardPasteResult,
  pane: ManagedPane
): boolean {
  if (
    result.status === 'skipped' &&
    result.reason === 'empty' &&
    getShortcutPlatform() === 'win32' &&
    // Web clients cannot resolve file paths, and execCommand('paste') may prompt (Firefox).
    !isWebClientLocation() &&
    document.activeElement === pane.terminal.textarea
  ) {
    clearPendingUnreadWindowsClipboardNativePaste()
    pendingNativePastePane = pane
    pendingNativePasteTimerId = window.setTimeout(
      clearPendingUnreadWindowsClipboardNativePaste,
      PENDING_NATIVE_PASTE_TIMEOUT_MS
    )
    try {
      window.api.ui.performNativePaste()
    } catch (error) {
      clearPendingUnreadWindowsClipboardNativePaste()
      throw error
    }
    return true
  }
  return false
}

/** Consume the one-shot fallback armed after main's clipboard read returned empty on Windows. */
export function consumeUnreadWindowsClipboardNativePaste(pane: ManagedPane): boolean {
  if (pendingNativePastePane !== pane) {
    return false
  }
  clearPendingUnreadWindowsClipboardNativePaste()
  return true
}

/** Snapshot during dispatch: clipboardData is unreadable once the paste event returns. */
export function clipboardEventCarriesFiles(event: ClipboardEvent): boolean {
  // `types` avoids reading `files`, which makes Chromium encode clipboard bitmaps synchronously.
  return event.clipboardData?.types.includes('Files') ?? false
}

/** A paste event is the last route; files it carried but nothing could paste must not fail silently. */
export function reportUnpastedClipboardEventFiles(
  result: TerminalClipboardPasteResult,
  eventCarriedFiles: boolean
): void {
  if (eventCarriedFiles && result.status === 'skipped' && result.reason === 'empty') {
    toast.error(
      translate(
        'components.terminalPane.paste.clipboardUnpastable',
        "Couldn't paste the copied file. Try dragging it into the terminal."
      )
    )
  }
}
