import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import { tryRuntimeTargetForWorktreeOwner } from '../../../../store/slices/worktrees/listing/worktree-owner-target'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  return useAppStore(
    useShallow((state) => {
      const entry = preferredPaneKey
        ? state.agentStatusByPaneKey.get(preferredPaneKey)
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
      const paneKey = preferredPaneKey ?? entry?.paneKey ?? `${terminalTabId}:`
      const shellForeground = state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true
      const resume = state.terminalPaneResumeOutcomesByPaneKey[paneKey]
      const restoredPtyId = resume?.outcome === 'restored' ? resume.ptyId : undefined
      const record = preferredPaneKey
        ? state.sleepingAgentSessionsByPaneKey[preferredPaneKey]
        : undefined
      const saved =
        record?.agent === 'claude' &&
        !record.connectionId &&
        tryRuntimeTargetForWorktreeOwner(state, record.worktreeId)?.kind === 'local'
          ? record
          : undefined
      return { entry, saved, paneKey, shellForeground, restoredPtyId }
    })
  )
}
