import { useAppStore } from '@/store'
import { gateWorktreeAgentActivation } from '@/lib/worktree-agent-activation-gate'
import { resolveWorkspaceTerminalHostAuthority } from '@/lib/workspace-terminal-host-authority'
import type { WorkspaceMultiplexerSlot } from '../../../../shared/workspace-multiplexer-types'
import {
  workspaceMultiplexerOwnsTerminalTabs,
  type WorkspaceMultiplexerCatalogItem
} from './workspace-multiplexer-model'

export async function ensureWorkspaceMultiplexerTerminal(
  slot: WorkspaceMultiplexerSlot,
  workspace: WorkspaceMultiplexerCatalogItem,
  createTerminalIfEmpty: boolean
): Promise<void> {
  let state = useAppStore.getState()
  if (resolveWorkspaceTerminalHostAuthority(state, slot.worktreeId) !== 'none') {
    return
  }
  if (
    !(state.unifiedTabsByWorktree[slot.worktreeId] ?? []).some(
      (tab) => tab.contentType === 'terminal'
    )
  ) {
    try {
      // Reuse the host-owned PTY before considering a new shell.
      if ((await gateWorktreeAgentActivation(slot.worktreeId)) !== 'empty') {
        return
      }
    } catch (error) {
      console.warn('[workspace-multiplexer] terminal activation failed', error)
      return
    }
  }
  if (!createTerminalIfEmpty) {
    return
  }
  state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[slot.worktreeId] ?? []
  if (
    !slot.groupId ||
    !state.workspaceMultiplexer.slots.some((current) => current.id === slot.id) ||
    !(state.groupsByWorktree[slot.worktreeId] ?? []).some((group) => group.id === slot.groupId) ||
    !workspaceMultiplexerOwnsTerminalTabs(
      workspace,
      tabs,
      state.restoredRuntimeHostIdByWorkspaceSessionKey[slot.worktreeId]
    ) ||
    resolveWorkspaceTerminalHostAuthority(state, slot.worktreeId) !== 'none' ||
    tabs.some((tab) => tab.groupId === slot.groupId && tab.contentType === 'terminal')
  ) {
    return
  }
  state.createTab(slot.worktreeId, slot.groupId, undefined, {
    activate:
      state.activeWorktreeId === slot.worktreeId &&
      state.activeGroupIdByWorktree[slot.worktreeId] === slot.groupId,
    recordInteraction: false
  })
}
