import { NativeChatSessionGate } from './NativeChatSessionGate'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import { useNativeChatStatusEntry } from './use-native-chat-status-entry'
import type { NativeChatViewProps } from './native-chat-view-types'
import { NativeChatPaneFileDropSurface } from './NativeChatPaneFileDropSurface'
import { useAppStore } from '../../store'

export type { NativeChatViewProps } from './native-chat-view-types'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView(props: NativeChatViewProps): React.JSX.Element {
  return (
    <NativeChatPaneFileDropSurface className="relative flex h-full min-h-0 min-w-0 w-full">
      {props.mode === 'structured' ? (
        <NativeChatStructuredSession key={props.sessionId} {...props} />
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
  contextMenuActions
}: Exclude<NativeChatViewProps, { mode: 'structured' }>): React.JSX.Element {
  const { entry: agentStatusEntry, paneKey } = useNativeChatStatusEntry(
    terminalTabId,
    preferredPaneKey
  )
  const resumeClaim = useAppStore((state) => state.automaticAgentResumeClaimsByTabId[terminalTabId])
  const shellForeground = useAppStore(
    (state) => state.paneForegroundAgentByPaneKey[paneKey]?.shellForeground === true
  )
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      resumeSession={
        ownsTabWideLaunchDraft && !shellForeground && resumeClaim
          ? { agent: resumeClaim.launchAgent, providerSession: resumeClaim.providerSession }
          : null
      }
      ptyId={targetPtyId}
    >
      {(resolution) => (
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
          contextMenuActions={contextMenuActions}
        />
      )}
    </NativeChatSessionGate>
  )
}
