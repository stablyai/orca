import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAgentStatusSelector } from '@/store/agent-status'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const keys = useMemo(
    () => (preferredPaneKey ? [preferredPaneKey] : undefined),
    [preferredPaneKey]
  )
  const entry = useAgentStatusSelector(
    useShallow((state) =>
      preferredPaneKey
        ? state.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
    ),
    keys,
    preferredPaneKey ? undefined : terminalTabId
  )
  return {
    entry,
    paneKey: preferredPaneKey ?? entry?.paneKey ?? `${terminalTabId}:`
  }
}
