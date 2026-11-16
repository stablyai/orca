import type { RefObject } from 'react'
import { NativeChatSwarmBoardPanel } from '@/components/native-chat/swarm/NativeChatSwarmBoardPanel'
import { NativeChatUsageLimitActionsProvider } from '@/components/native-chat/usage/NativeChatUsageLimitActions'
import type { NativeChatComposerHandle } from '@/components/native-chat/composer/native-chat-composer-types'
import { NativeChatEmptyState } from '@/components/native-chat/host-access/NativeChatEmptyState'
import { NativeChatEmptyPane } from '@/components/native-chat/host-access/NativeChatEmptyPane'
import { NativeChatLoadingCue } from '@/components/native-chat/host-access/NativeChatLoadingCue'
import { NativeChatSubagentTranscripts } from '@/components/native-chat/subagents/NativeChatSubagentTranscripts'
import { NativeChatContextClearFade } from '@/components/native-chat/conversation/projection/NativeChatContextClearFade'
import { NativeChatFindBar } from '@/components/native-chat/viewport/find/NativeChatFindBar'
import { NativeChatHostSetupContext } from '@/components/native-chat/host-access/native-chat-host-setup'
import { NativeChatWorkerApprovalTimeline } from '@/components/native-chat/worker-approvals/NativeChatWorkerApprovals'
import { NativeChatRowActionsProvider } from '@/components/native-chat/messages/actions/NativeChatRowActionsProvider'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { useStructuredChatLiveSession } from './use-structured-chat-live-session'
import type {
  selectNativeChatViewState,
  structuredChatHistoryPhase
} from '@/components/native-chat/session/status/native-chat-view-state'
import type { structuredAgentSessionReadFailureNotice } from '@/components/native-chat/messages/notices/structured-agent-session-read-failure-notice'
import type { useNativeChatInstallSlot } from '@/components/native-chat/host-access/NativeChatInstallSlot'
import type { useNativeChatFind } from '@/components/native-chat/viewport/find/use-native-chat-find'
import type { useNativeChatPaneFork } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import type { useNativeChatFileLinkContext } from '@/components/native-chat/links/actions/use-native-chat-file-link-context'
import type { useNativeChatInterruptedContinuation } from '@/components/native-chat/usage/NativeChatInterruptedContinue'
import type { useNativeChatStructuredPaneNotices } from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import type { nativeChatWorkerApprovalParty } from '@/components/native-chat/worker-approvals/NativeChatWorkerApprovals'
import type { useStructuredNativeChatSubmitReveal } from '@/components/native-chat/pane/actions/use-structured-native-chat-submit-reveal'
import type { nativeChatStructuredStopControls } from '@/components/native-chat/session/structured/writes/native-chat-structured-stop-controls'
import type { NativeChatImageRuntimeContext } from '@/components/native-chat/media/images/native-chat-image-runtime-context'
import type { useStructuredAgentSessionDeliveryNotices } from './delivery/use-structured-agent-session-delivery-notices'
import type { useNativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/use-native-chat-structured-composer-transport'

export function NativeChatStructuredSessionTranscript({
  props,
  paneKey,
  controller,
  session,
  viewState,
  historyPhase,
  readFailure,
  install,
  find,
  forks,
  fileLinkContext,
  continuation,
  setup,
  workerApprovalParty,
  submits,
  prompt,
  stopControls,
  imageRuntimeContext,
  deliveryNotices,
  composerRef,
  canMention,
  focusComposer,
  transport
}: {
  props: Omit<NativeChatStructuredViewProps, 'mode'>
  paneKey: string
  controller: ReturnType<typeof useStructuredAgentSession>
  session: ReturnType<typeof useStructuredChatLiveSession>
  viewState: ReturnType<typeof selectNativeChatViewState>
  historyPhase: ReturnType<typeof structuredChatHistoryPhase>
  readFailure: ReturnType<typeof structuredAgentSessionReadFailureNotice> | null
  install: ReturnType<typeof useNativeChatInstallSlot>
  find: ReturnType<typeof useNativeChatFind>
  forks: ReturnType<typeof useNativeChatPaneFork>
  fileLinkContext: ReturnType<typeof useNativeChatFileLinkContext>
  continuation: ReturnType<typeof useNativeChatInterruptedContinuation>
  setup: ReturnType<typeof useNativeChatStructuredPaneNotices>['setup']
  workerApprovalParty: ReturnType<typeof nativeChatWorkerApprovalParty>
  submits: ReturnType<typeof useStructuredNativeChatSubmitReveal>
  prompt: ReturnType<typeof useStructuredAgentSession>['prompts'][number] | null
  stopControls: ReturnType<typeof nativeChatStructuredStopControls>
  imageRuntimeContext: NativeChatImageRuntimeContext
  deliveryNotices: ReturnType<typeof useStructuredAgentSessionDeliveryNotices>
  composerRef: RefObject<NativeChatComposerHandle | null>
  canMention: boolean
  focusComposer: () => void
  transport: ReturnType<typeof useNativeChatStructuredComposerTransport>
}): React.JSX.Element {
  return (
    <>
      {transport.swarmBoard ? (
        <NativeChatSwarmBoardPanel
          board={transport.swarmBoard}
          canMention={canMention}
          onMention={(name) => {
            composerRef.current?.insertTypedText(`@${name} `)
            focusComposer()
          }}
          onCloseFocus={focusComposer}
        />
      ) : null}
      <NativeChatContextClearFade
        // A read failure stays in view: no divider may come to end the fade.
        clearing={controller.contextClear.clearing && viewState.kind !== 'error'}
        overlay={find.isOpen ? <NativeChatFindBar find={find} isVisible={props.isVisible} /> : null}
      >
        {viewState.kind === 'loading' || (viewState.kind === 'error' && !readFailure) ? (
          historyPhase !== 'unread' && <NativeChatLoadingCue />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState
            kind="error"
            retrying={!readFailure?.final}
            {...(readFailure?.named ? { headline: readFailure.text } : {})}
          />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyPane slot={install.slot} agent={props.agent} />
        ) : (
          <NativeChatRowActionsProvider pane={props} chat={controller} forks={forks}>
            <NativeChatUsageLimitActionsProvider
              recovery={controller}
              pane={props}
              directory={fileLinkContext}
              messages={controller.messages}
              view={continuation.view}
            >
              <NativeChatHostSetupContext.Provider value={setup}>
                <NativeChatWorkerApprovalTimeline party={workerApprovalParty}>
                  {(timedRows) => (
                    <NativeChatSubagentTranscripts
                      find={find}
                      // A rewind or a /clear replaces the conversation; nothing the old one held carries over.
                      key={`${controller.epoch}:${controller.contextClear.clears}`}
                      paneKey={paneKey}
                      ref={submits.messageListRef}
                      session={session}
                      journalItems={controller.journalItems}
                      journalSubmissions={controller.submissions}
                      journalLatestTurn={controller.latestTurn}
                      journalHostWork={controller.hostWork}
                      subagentRoster={controller.subagentRoster}
                      railOutline={controller.railOutline}
                      isVisible={props.isVisible}
                      isWorking={controller.isWorking}
                      expandSignal={false}
                      workingStartedAt={controller.workingStartedAt}
                      settledTurns={controller.settledTurns}
                      awaitingInput={prompt === null ? null : 'shown'}
                      turnActivity={controller.turnActivity}
                      stopping={stopControls.stopping}
                      structuredAttachments
                      runtimeContext={imageRuntimeContext}
                      deliveryNotices={deliveryNotices}
                      timedRows={timedRows}
                    />
                  )}
                </NativeChatWorkerApprovalTimeline>
              </NativeChatHostSetupContext.Provider>
            </NativeChatUsageLimitActionsProvider>
          </NativeChatRowActionsProvider>
        )}
      </NativeChatContextClearFade>
    </>
  )
}
