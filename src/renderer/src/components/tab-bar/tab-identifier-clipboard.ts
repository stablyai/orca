import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { copyTerminalHandleForPane } from '../terminal-pane/terminal-handle-copy'
import { runTerminalIdentityCopy } from '../terminal-pane/terminal-copy-rejection-guards'
import { resolveTabIdentityLeafId } from './tab-terminal-identifiers'

/** No-op focus handoff: the menu opens from the tab strip, so no pane held focus to give back. */
const NO_PANE_TO_REFOCUS = (): void => {}

/** Runtime terminal handle of the tab's focused pane — what agents and the CLI address. */
export async function copyTabTerminalId(tabId: string): Promise<void> {
  try {
    const leafId = resolveTabIdentityLeafId(useAppStore.getState().terminalLayoutsByTabId[tabId])
    if (!leafId) {
      throw new Error('terminal_not_found')
    }
    await copyTerminalHandleForPane({
      tabId,
      leafId,
      callRuntime: window.api.runtime.call,
      writeClipboardText: window.api.ui.writeClipboardText
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
  }
}

/**
 * Provider-owned session id the tab can be resumed by, already resolved by the menu so the item
 * is hidden when there is none to copy. Routed through the shared identity-copy guard rather than
 * a local try/catch, so a rejected clipboard write toasts the failure instead of a false success.
 */
export async function copyTabAgentSessionId(sessionId: string): Promise<void> {
  await runTerminalIdentityCopy({
    text: sessionId,
    writeClipboardText: window.api.ui.writeClipboardText,
    onSuccess: () =>
      toast.success(
        translate(
          'components.terminalPane.TerminalContextMenu.copySessionIdSuccess',
          'Session ID copied'
        )
      ),
    onError: () =>
      toast.error(
        translate(
          'components.terminalPane.TerminalContextMenu.copySessionIdError',
          'Unable to copy session ID'
        )
      ),
    focus: NO_PANE_TO_REFOCUS
  })
}
