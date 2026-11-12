import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  copyTerminalPaneMenuAgentSessionId,
  copyTerminalPaneMenuCommandBlock,
  copyTerminalPaneMenuPaneId,
  copyTerminalPaneMenuSelection,
  copyTerminalPaneMenuTerminalId
} from './terminal-pane-menu-copy-actions'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolvePaneAgentSessionId } from '../../../lib/agent-session/identity/pane-agent-session-id'
import type { UseTerminalPaneContextMenuDeps } from '../context-menu/terminal-pane-context-menu-types'
import type { TerminalCommandBlockPart } from '../emulation/commands/terminal-command-block-text'
import type { TrackedCommandBlock } from '../emulation/commands/terminal-command-block-tracker'

export function createTerminalPaneMenuCopyActions({
  paneTransportsRef,
  tabId,
  resolveMenuPane,
  resolveMenuBufferRow,
  resolveMenuCommandBlock
}: Pick<UseTerminalPaneContextMenuDeps, 'paneTransportsRef' | 'tabId'> & {
  resolveMenuPane: () => ManagedPane | null
  resolveMenuBufferRow: () => number | null
  resolveMenuCommandBlock: () => TrackedCommandBlock | null
}) {
  const onCopy = async (): Promise<void> => copyTerminalPaneMenuSelection(resolveMenuPane())

  const onCopyCommandBlock = async (part: TerminalCommandBlockPart): Promise<void> =>
    copyTerminalPaneMenuCommandBlock(
      resolveMenuPane(),
      resolveMenuCommandBlock(),
      resolveMenuBufferRow(),
      part
    )

  const onSelectAll = (): void => {
    const pane = resolveMenuPane()
    if (pane) {
      pane.terminal.selectAll()
      pane.terminal.focus()
    }
  }

  const onCopyPaneId = async (): Promise<void> =>
    copyTerminalPaneMenuPaneId(resolveMenuPane(), tabId)

  const onCopyTerminalId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    const ptyId = pane ? (paneTransportsRef.current?.get(pane.id)?.getPtyId() ?? null) : null
    return copyTerminalPaneMenuTerminalId(pane, tabId, ptyId)
  }

  const onCopyAgentSessionId = async (): Promise<void> => {
    const pane = resolveMenuPane()
    const sessionId = pane
      ? resolvePaneAgentSessionId(useAppStore.getState(), makePaneKey(tabId, pane.leafId))
      : null
    return copyTerminalPaneMenuAgentSessionId(pane, sessionId)
  }
  return {
    onCopy,
    onSelectAll,
    onCopyPaneId,
    onCopyTerminalId,
    onCopyAgentSessionId,
    onCopyCommandBlock
  }
}
