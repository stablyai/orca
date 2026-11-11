import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import {
  copyTerminalPaneMenuAgentSessionId,
  copyTerminalPaneMenuPaneId,
  copyTerminalPaneMenuSelection,
  copyTerminalPaneMenuTerminalId
} from './terminal-pane-menu-copy-actions'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { resolvePaneAgentSessionId } from '../../../lib/agent-session/identity/pane-agent-session-id'
import type {
  TerminalPaneAgentIdCopy,
  UseTerminalPaneContextMenuDeps
} from '../context-menu/terminal-pane-context-menu-types'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

export function createTerminalPaneMenuCopyActions({
  paneTransportsRef,
  tabId,
  worktreeId,
  resolveMenuPane
}: Pick<UseTerminalPaneContextMenuDeps, 'paneTransportsRef' | 'tabId' | 'worktreeId'> & {
  resolveMenuPane: () => ManagedPane | null
}) {
  const onCopy = async (): Promise<void> => copyTerminalPaneMenuSelection(resolveMenuPane())

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
  let agentIdPane: ManagedPane | null = null
  const agentIdCopy: TerminalPaneAgentIdCopy = {
    // The pane's execution host names its agents, so ask the owner; a failed commit retries there.
    resolve: async () => {
      const pane = resolveMenuPane()
      agentIdPane = pane
      const target = tryRuntimeTargetForWorktreeOwner(useAppStore.getState(), worktreeId)
      if (!pane || !target) {
        return null
      }
      const result = await callRuntimeRpc<{ orcaSessionId: string | null }>(
        target,
        'terminal.agentId',
        { paneKey: makePaneKey(tabId, pane.leafId), worktreeId }
      )
      return result.orcaSessionId
    },
    // Like Copy Session ID: xterm needs its textarea focused for typing after the menu (#592).
    focusPane: () => agentIdPane?.terminal.focus()
  }
  return {
    onCopy,
    onSelectAll,
    onCopyPaneId,
    onCopyTerminalId,
    onCopyAgentSessionId,
    agentIdCopy
  }
}
