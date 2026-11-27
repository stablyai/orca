import { NativeChatComposer } from './NativeChatComposer'
import { NativeChatComposerExtensionUi } from './controls/NativeChatComposerExtensionUi'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
import type { NativeChatLiveSession } from '../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatStructuredViewProps } from '../native-chat-view-types'
import type { useNativeChatBotHome } from '../NativeChatBotHomeScope'
import type { useStructuredNativeChatSubmitReveal } from '../pane/actions/use-structured-native-chat-submit-reveal'
import type { AgentSessionExtensionStripRows } from '../../../../../shared/agent-session/view/agent-session-extension-ui'

/** The chat's structured input, with the extension widgets it draws underneath it. */
export function NativeChatStructuredComposerInput({
  ref,
  pane,
  paneKey,
  stopControls,
  queuedMessages,
  unavailableHint,
  session,
  notices,
  transport,
  extensionUi
}: {
  ref?: React.Ref<NativeChatComposerHandle>
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'sessionId'>
  paneKey: string
  stopControls: ReturnType<typeof useNativeChatBotHome>['stopControls']
  queuedMessages: ReturnType<typeof useStructuredNativeChatSubmitReveal>['queuedMessages']
  unavailableHint: string | undefined
  session: Pick<NativeChatLiveSession, 'messages'>
  notices: NativeChatComposerProps['notices']
  transport: NonNullable<NativeChatComposerProps['structuredTransport']>
  extensionUi: AgentSessionExtensionStripRows
}): React.JSX.Element {
  return (
    <>
      <NativeChatComposer
        ref={ref}
        terminalTabId={pane.tabId}
        paneKey={paneKey}
        draftScopeKey={structuredAgentSessionDraftScopeKey(pane.sessionId)}
        targetPtyId={null}
        agent={pane.agent}
        {...stopControls.composer}
        unavailableHint={unavailableHint}
        steerHead={stopControls.stopping ? undefined : queuedMessages.steerHead}
        structuredTransport={transport}
        notices={notices}
        recallSource={{ messages: session.messages, withoutImageMarkers: true }}
      />
      <NativeChatComposerExtensionUi rows={extensionUi} placement="below" />
    </>
  )
}
