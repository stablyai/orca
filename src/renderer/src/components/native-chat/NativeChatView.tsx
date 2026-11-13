import { NativeChatSessionGate } from './host-access/NativeChatSessionGate'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import { useNativeChatStatusEntry } from './session/status/use-native-chat-status-entry'
import type { NativeChatViewProps } from './native-chat-view-types'
import { NativeChatPaneFileDropSurface } from './attachments/intake/NativeChatPaneFileDropSurface'
import { NativeChatVisualOwnerProvider } from './media/visuals/native-chat-visual-owner'
import { NativeChatFileLinkExistenceProvider } from './links/actions/use-native-chat-file-link-existence'
import { NativeChatMarkdownImageOwnerProvider } from './media/images/native-chat-markdown-image-owner'
import { CloudChatBannerSlot } from '../agent-sign-in-strip/CloudChatBannerSlot'
import { CloudChatHostProvider } from '../agent-sign-in-strip/cloud-chat-sign-in-notice'

export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  return (
    <NativeChatPaneFileDropSurface className="relative flex h-full min-h-0 min-w-0 w-full">
      {props.mode === 'structured' ? (
        <NativeChatVisualOwnerProvider
          key={props.sessionId}
          target={props.target}
          sessionId={props.sessionId}
          tabId={props.tabId}
        >
          <NativeChatFileLinkExistenceProvider tabId={props.tabId}>
            <NativeChatMarkdownImageOwnerProvider
              tabId={props.tabId}
              isVisible={props.isVisible}
              sessionId={props.sessionId}
            >
              <CloudChatHostProvider target={props.target}>
                <NativeChatStructuredSession {...props} />
              </CloudChatHostProvider>
            </NativeChatMarkdownImageOwnerProvider>
          </NativeChatFileLinkExistenceProvider>
        </NativeChatVisualOwnerProvider>
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
  readTerminalScreen,
  readTerminalDraft,
  contextMenuActions
}: Exclude<NativeChatViewProps, { mode: 'structured' }>): React.JSX.Element {
  const { entry: agentStatusEntry, paneKey } = useNativeChatStatusEntry(
    terminalTabId,
    preferredPaneKey
  )
  // CHAT-BANNERS: the pane's cloud banners show above the chat while it covers the pane.
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {preferredPaneKey ? <CloudChatBannerSlot paneKey={preferredPaneKey} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <NativeChatSessionGate
          paneKey={paneKey}
          launchAgent={launchAgent}
          resolvedAgent={resolvedAgent}
          agentStatusEntry={agentStatusEntry}
          ptyId={targetPtyId}
        >
          {(resolution) => (
            <NativeChatFileLinkExistenceProvider tabId={terminalTabId}>
              <NativeChatMarkdownImageOwnerProvider
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
                  readTerminalScreen={readTerminalScreen}
                  readTerminalDraft={readTerminalDraft}
                  contextMenuActions={contextMenuActions}
                />
              </NativeChatMarkdownImageOwnerProvider>
            </NativeChatFileLinkExistenceProvider>
          )}
        </NativeChatSessionGate>
      </div>
    </div>
  )
}
