import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { translate } from '@/i18n/i18n'
import { copyTerminalHandleForPane } from './terminal-handle-copy'
import { runCopyPaneId, runTerminalCopy } from './terminal-copy-rejection-guards'

export const copyTerminalPaneMenuSelection = async (pane: ManagedPane | null): Promise<void> => {
  if (!pane) {
    return
  }
  await runTerminalCopy({
    selection: pane.terminal.getSelection(),
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
    // Why: Radix returns focus to the menu trigger (the pane container) on
    // close, but xterm.js only accepts input when its own helper textarea is
    // focused. Without this, the user has to click the pane again before
    // typing works (see #592).
    focus: () => pane.terminal.focus()
  })
}

export const copyTerminalPaneMenuPaneId = async (
  pane: ManagedPane | null,
  tabId: string
): Promise<void> => {
  if (!pane) {
    return
  }
  await runCopyPaneId({
    // Why: orchestration targets use ORCA_PANE_KEY, which survives renderer
    // remounts; the numeric PaneManager id is only a local runtime handle.
    paneKey: makePaneKey(tabId, pane.leafId),
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
    onSuccess: () =>
      toast.success(
        translate(
          'auto.components.terminal.pane.use.terminal.pane.context.menu.a29b9faa01',
          'Pane ID copied'
        )
      ),
    // Why: claiming success after a failed write is the exact silent lie this
    // fallback exists to remove, so report it the way Copy Terminal ID does.
    onError: () =>
      toast.error(
        translate(
          'auto.components.terminal.pane.use.terminal.pane.context.menu.pane.id.copy.failed',
          'Unable to copy pane ID'
        )
      ),
    focus: () => pane.terminal.focus()
  })
}

export const copyTerminalPaneMenuTerminalId = async (
  pane: ManagedPane | null,
  tabId: string
): Promise<void> => {
  if (!pane) {
    return
  }
  try {
    await copyTerminalHandleForPane({
      tabId,
      leafId: pane.leafId,
      callRuntime: window.api.runtime.call,
      writeClipboardText: window.api.ui.writeTerminalClipboardText
    })
    toast.success(
      translate(
        'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copied',
        'Terminal ID copied'
      )
    )
  } catch {
    toast.error(
      translate(
        'auto.components.terminal.pane.use.terminal.pane.context.menu.terminal.id.copy.failed',
        'Unable to copy terminal ID'
      )
    )
  } finally {
    pane.terminal.focus()
  }
}
