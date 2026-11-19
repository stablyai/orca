import { useShallow } from 'zustand/react/shallow'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const entry = useAppStoreWithChannels(
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
