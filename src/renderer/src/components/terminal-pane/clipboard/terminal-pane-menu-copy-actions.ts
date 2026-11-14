import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { translate } from '@/i18n/i18n'
import { copyTerminalHandleForPane } from './terminal-handle-copy'
import { runTerminalCopy, runTerminalIdentityCopy } from './terminal-copy-rejection-guards'
import { readTerminalClipboardSelection } from './terminal-clipboard-selection-text'
import { useAppStore } from '@/store/index'
import { fencedCode } from '../../editor/selection-copy'
import { formatNativeChatQuote } from '../../native-chat/selection-quotes/native-chat-quote-selection'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

export const copyTerminalPaneMenuSelection = async (pane: ManagedPane | null): Promise<void> => {
  if (!pane) {
    return
  }
  await runTerminalCopy({
    selection: readTerminalClipboardSelection(pane.terminal),
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
    // Radix restores the container, but xterm needs its textarea focused for typing (#592).
    focus: () => pane.terminal.focus()
  })
}

/** The selection quoted under the terminal tab's title, for the Add to chat target list. */
export const terminalPaneMenuAddToChat = (
  pane: ManagedPane | null,
  tabId: string,
  worktreeId: string
): { worktreeId: string; quote: string } | null => {
  const text = pane ? readTerminalClipboardSelection(pane.terminal).replace(/\s+$/, '') : ''
  if (!text.trim()) {
    return null
  }
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
  )
  const title = tab?.customLabel || tab?.label || 'Terminal'
  return {
    // The floating terminal belongs to no workspace; it floats over the one on screen.
    worktreeId:
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? (state.activeWorktreeId ?? worktreeId)
        : worktreeId,
    quote: formatNativeChatQuote(`${title}\n${fencedCode(text)}`)
  }
}

export const copyTerminalPaneMenuPaneId = async (
  pane: ManagedPane | null,
  tabId: string
): Promise<void> => {
  if (!pane) {
    return
  }
  await runTerminalIdentityCopy({
    // ORCA_PANE_KEY survives remounts; numeric PaneManager IDs are local handles.
    text: makePaneKey(tabId, pane.leafId),
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
    onSuccess: () =>
      toast.success(
        translate(
          'auto.components.terminal.pane.use.terminal.pane.context.menu.a29b9faa01',
          'Pane ID copied'
        )
      ),
    // Report clipboard rejection rather than falsely toasting success, matching Copy Terminal ID.
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
  tabId: string,
  ptyId: string | null
): Promise<void> => {
  if (!pane) {
    return
  }
  try {
    await copyTerminalHandleForPane({
      tabId,
      leafId: pane.leafId,
      ptyId,
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

export const copyTerminalPaneMenuAgentSessionId = async (
  pane: ManagedPane | null,
  sessionId: string | null
): Promise<void> => {
  if (!pane) {
    return
  }
  if (!sessionId) {
    pane.terminal.focus()
    return
  }
  await runTerminalIdentityCopy({
    text: sessionId,
    writeClipboardText: window.api.ui.writeTerminalClipboardText,
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
    focus: () => pane.terminal.focus()
  })
}
