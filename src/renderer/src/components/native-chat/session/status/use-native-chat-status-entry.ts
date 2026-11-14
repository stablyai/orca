import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const entry = useAppStore(
    useShallow((state) =>
      preferredPaneKey
        ? state.agentStatusByPaneKey.get(preferredPaneKey)
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
    )
  )
  return {
    entry,
    paneKey: preferredPaneKey ?? entry?.paneKey ?? `${terminalTabId}:`
  }
}
