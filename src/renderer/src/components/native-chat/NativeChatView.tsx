import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import { NativeChatConversation } from './NativeChatConversation'
import type { NativeChatViewProps } from './native-chat-view-types'

export type { NativeChatViewProps } from './native-chat-view-types'
export type {
  NativeChatConversationLiveState,
  NativeChatConversationProps
} from './native-chat-conversation-types'
export { NativeChatConversation } from './NativeChatConversation'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView({
  terminalTabId,
  isVisible,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: NativeChatViewProps): React.JSX.Element {
  const agentStatusEntry = useAppStore(
    useShallow((state) =>
      preferredPaneKey
        ? state.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
    )
  )
  const paneKey = preferredPaneKey ?? agentStatusEntry?.paneKey ?? `${terminalTabId}:`
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      ptyId={targetPtyId}
    >
      {(resolution) => (
        <NativeChatConversation
          paneKey={resolution.paneKey}
          agent={resolution.agent}
          sessionId={resolution.sessionId}
          transcriptPath={resolution.transcriptPath}
          isVisible={isVisible}
          targetPtyId={targetPtyId}
          terminalTabId={terminalTabId}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          contextMenuActions={contextMenuActions}
        />
      )}
    </NativeChatSessionGate>
  )
}
