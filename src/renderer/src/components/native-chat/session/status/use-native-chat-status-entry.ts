import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import { tryRuntimeTargetForWorktreeOwner } from '../../../../store/slices/worktrees/listing/worktree-owner-target'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const { entry, saved } = useAppStore(
    useShallow((state) => {
      const entry = preferredPaneKey
        ? state.agentStatusByPaneKey.get(preferredPaneKey)
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
      const record = preferredPaneKey
        ? state.sleepingAgentSessionsByPaneKey[preferredPaneKey]
        : undefined
      const saved =
        record?.agent === 'claude' &&
        !record.connectionId &&
        (!entry || entry.restoredUnconfirmed) &&
        !state.paneForegroundAgentByPaneKey[record.paneKey]?.shellForeground &&
        tryRuntimeTargetForWorktreeOwner(state, record.worktreeId)?.kind === 'local'
          ? record
          : undefined
      return { entry, saved }
    })
  )
  return {
    entry,
    saved,
    paneKey: preferredPaneKey ?? entry?.paneKey ?? `${terminalTabId}:`
  }
}
