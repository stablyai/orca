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
import type { AgentSessionExtensionStripRows } from '../../../../../../shared/agent-session/view/agent-session-extension-ui'

type StructuredComposerInputParts = {
  composerRef: React.Ref<NativeChatComposerHandle>
  paneKey: string
  stopControls: ReturnType<typeof useNativeChatBotHome>['stopControls']
  queuedMessages: ReturnType<typeof useStructuredNativeChatSubmitReveal>['queuedMessages']
  unavailableHint: string | undefined
  session: Pick<NativeChatLiveSession, 'messages'>
  notices: NativeChatComposerProps['notices']
  transport: NonNullable<NativeChatComposerProps['structuredTransport']>
  extensionUi: AgentSessionExtensionStripRows
}

/** The chat's structured input, with the extension widgets it draws underneath it. */
export function nativeChatStructuredComposerInput(
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'agent' | 'sessionId'>,
  parts: StructuredComposerInputParts
): React.JSX.Element {
  return (
    <>
      <NativeChatComposer
        ref={parts.composerRef}
        terminalTabId={pane.tabId}
        paneKey={parts.paneKey}
        draftScopeKey={structuredAgentSessionDraftScopeKey(pane.sessionId)}
        targetPtyId={null}
        agent={pane.agent}
        {...parts.stopControls.composer}
        unavailableHint={parts.unavailableHint}
        steerHead={parts.stopControls.stopping ? undefined : parts.queuedMessages.steerHead}
        structuredTransport={parts.transport}
        notices={parts.notices}
        recallSource={{ messages: parts.session.messages, withoutImageMarkers: true }}
      />
      <NativeChatComposerExtensionUi rows={parts.extensionUi} placement="below" />
    </>
  )
}
