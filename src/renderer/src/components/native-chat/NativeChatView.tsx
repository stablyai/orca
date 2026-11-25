import { BotChatRoom } from '../bots/use-bot-chat-composer-room'
import { NativeChatSessionGate } from './host-access/NativeChatSessionGate'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import { useNativeChatStatusEntry } from './session/status/use-native-chat-status-entry'
import type { NativeChatViewProps } from './native-chat-view-types'
import { NativeChatPaneFileDropSurface } from './attachments/intake/NativeChatPaneFileDropSurface'
import { NativeChatTabTranscriptScope } from './native-chat-transcript-scope'
import { NativeChatWorkersProvider } from './native-chat-workers-context'

export type { NativeChatViewProps } from './native-chat-view-types'

export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  return (
    <NativeChatPaneFileDropSurface className="relative flex h-full min-h-0 min-w-0 w-full">
      {props.mode === 'structured' ? (
        <NativeChatTabTranscriptScope
          key={props.sessionId}
          tabId={props.tabId}
          isVisible={props.isVisible}
          sessionId={props.sessionId}
          target={props.target}
        >
          <NativeChatWorkersProvider
            target={props.target}
            sessionId={props.sessionId}
            visible={props.isVisible}
          >
            <BotChatRoom tabId={props.tabId} sessionId={props.sessionId}>
              <NativeChatStructuredSession {...props} />
            </BotChatRoom>
          </NativeChatWorkersProvider>
        </NativeChatTabTranscriptScope>
      ) : (
        <NativeChatBridgeView {...props} />
      )}
    </NativeChatPaneFileDropSurface>
  )
}

function NativeChatBridgeView({
  terminalTabId,
  isVisible,
  isFocusedGroup,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalDraft,
  contextMenuActions
}: Exclude<NativeChatViewProps, { mode: 'structured' }>): React.JSX.Element {
  const { entry: agentStatusEntry, paneKey } = useNativeChatStatusEntry(
    terminalTabId,
    preferredPaneKey
  )
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      ptyId={targetPtyId}
    >
      {(resolution) => (
        <NativeChatTabTranscriptScope
          sessionId={resolution.sessionId}
          tabId={terminalTabId}
          isVisible={isVisible}
        >
          <NativeChatResolvedView
            paneKey={resolution.paneKey}
            agent={resolution.agent}
            sessionId={resolution.sessionId}
            transcriptPath={resolution.transcriptPath}
            isVisible={isVisible}
            isFocusedGroup={isFocusedGroup}
            targetPtyId={targetPtyId}
            terminalTabId={terminalTabId}
            ownsTabWideLaunchDraft={ownsTabWideLaunchDraft}
            onSwitchToTerminal={onSwitchToTerminal}
            readTerminalDraft={readTerminalDraft}
            contextMenuActions={contextMenuActions}
          />
        </NativeChatTabTranscriptScope>
      )}
    </NativeChatSessionGate>
  )
}
