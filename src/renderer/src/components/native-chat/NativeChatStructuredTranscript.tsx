import { NativeChatWorkerTimeline } from './tools/tasks/dock/NativeChatWorkerResultTimeline'
import {
  NativeChatPartyWorkerApprovalStack,
  nativeChatWorkerApprovalParty
} from './worker-approvals/NativeChatWorkerApprovals'
import { NativeChatSessionChildren } from './NativeChatSessionChildren'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatUsageLimitActionsProvider } from './usage/NativeChatUsageLimitActions'
import type { ComponentProps, ReactNode, Ref } from 'react'
import { NativeChatAntigravityAuthProvider } from './antigravity-auth/native-chat-antigravity-auth'
import { NativeChatSlackMirrorContext } from './slack-mirror/native-chat-slack-mirror'
import { NativeChatCrewContext } from '../orchestration-crew/use-native-chat-crew'
import { NativeChatChildNavigationContext } from './native-chat-child-navigation'
import { NativeChatSubagentTranscripts } from './subagents/NativeChatSubagentTranscripts'
import { NativeChatRowActionsProvider } from './messages/actions/NativeChatRowActionsProvider'
import {
  NativeChatHostSetupContext,
  type NativeChatHostSetup
} from './host-access/native-chat-host-setup'
import type { useNativeChatInterruptedContinuation } from './usage/NativeChatInterruptedContinue'
import type { useStructuredAgentSession } from './session/structured/use-structured-agent-session'
import type { NativeChatMessageListHandle } from './messages/actions/use-native-chat-reveal-latest'

export function NativeChatStructuredTranscript({
  pane,
  directory,
  controller,
  continuation,
  setup,
  forks,
  messageListRef,
  ...props
}: Omit<
  ComponentProps<typeof NativeChatSubagentTranscripts>,
  | 'ref'
  | 'journalItems'
  | 'journalSubmissions'
  | 'journalLatestTurn'
  | 'journalHostWork'
  | 'subagentRoster'
  | 'railOutline'
  | 'isWorking'
  | 'expandSignal'
  | 'workingStartedAt'
  | 'settledTurns'
  | 'turnActivity'
  | 'timedRows'
> & {
  pane: ComponentProps<typeof NativeChatUsageLimitActionsProvider>['pane']
  directory: ComponentProps<typeof NativeChatUsageLimitActionsProvider>['directory']
  controller: ReturnType<typeof useStructuredAgentSession>
  continuation: ReturnType<typeof useNativeChatInterruptedContinuation>['view']
  forks: ComponentProps<typeof NativeChatRowActionsProvider>['forks']
  setup: NativeChatHostSetup
  messageListRef: Ref<NativeChatMessageListHandle>
}): React.JSX.Element {
  return (
    <NativeChatRowActionsProvider pane={pane} chat={controller} forks={forks}>
      <NativeChatUsageLimitActionsProvider
        recovery={controller}
        pane={pane}
        directory={directory}
        messages={controller.messages}
        view={continuation}
      >
        <NativeChatHostSetupContext.Provider value={setup}>
          <NativeChatWorkerTimeline
            approvalParty={nativeChatWorkerApprovalParty(pane)}
            workerDock={controller.backgroundTasks.workerDock}
            target={pane.target}
            sessionId={pane.sessionId}
            isVisible={props.isVisible}
          >
            {(timedRows) => (
              <NativeChatSubagentTranscripts
                {...props}
                timedRows={timedRows}
                structuredAttachments
                key={`${controller.epoch}:${controller.contextClear.clears}`}
                ref={messageListRef}
                journalItems={controller.journalItems}
                journalSubmissions={controller.submissions}
                journalLatestTurn={controller.latestTurn}
                journalHostWork={controller.hostWork}
                subagentRoster={controller.subagentRoster}
                railOutline={controller.railOutline}
                isWorking={controller.isWorking}
                expandSignal={false}
                workingStartedAt={controller.workingStartedAt}
                settledTurns={controller.settledTurns}
                turnActivity={controller.turnActivity}
              />
            )}
          </NativeChatWorkerTimeline>
        </NativeChatHostSetupContext.Provider>
      </NativeChatUsageLimitActionsProvider>
    </NativeChatRowActionsProvider>
  )
}

/** The transcript area, with this chat's retained children above the conversation. */
export function NativeChatStructuredTranscriptFrame({
  pane,
  isVisible,
  children
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  isVisible: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <NativeChatSessionChildren {...pane} isVisible={isVisible} />
      {children}
    </div>
  )
}

export function NativeChatStructuredWorkerApprovals({
  pane,
  isVisible
}: {
  pane: Pick<NativeChatStructuredViewProps, 'target' | 'sessionId'>
  isVisible: boolean
}): React.JSX.Element {
  return (
    <NativeChatPartyWorkerApprovalStack
      party={nativeChatWorkerApprovalParty(pane)}
      target={pane.target}
      isVisible={isVisible}
    />
  )
}

/** What every part of a chat pane reads: its Antigravity sign-in, Slack mirror, crew and child navigation. */
export function NativeChatStructuredContexts({
  antigravityAuth,
  slackMirror,
  crew,
  childNavigation,
  children
}: {
  antigravityAuth: ComponentProps<typeof NativeChatAntigravityAuthProvider>['target']
  slackMirror: ComponentProps<typeof NativeChatSlackMirrorContext.Provider>['value']
  crew: ComponentProps<typeof NativeChatCrewContext.Provider>['value']
  childNavigation: ComponentProps<typeof NativeChatChildNavigationContext.Provider>['value']
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatAntigravityAuthProvider target={antigravityAuth}>
      <NativeChatSlackMirrorContext.Provider value={slackMirror}>
        <NativeChatCrewContext.Provider value={crew}>
          <NativeChatChildNavigationContext.Provider value={childNavigation}>
            {children}
          </NativeChatChildNavigationContext.Provider>
        </NativeChatCrewContext.Provider>
      </NativeChatSlackMirrorContext.Provider>
    </NativeChatAntigravityAuthProvider>
  )
}
