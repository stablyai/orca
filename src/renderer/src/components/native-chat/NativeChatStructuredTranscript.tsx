import { NativeChatCrewFrame, NativeChatCrewPanel } from '../orchestration-crew/NativeChatCrewPanel'
import { NativeChatSessionChildren } from './NativeChatSessionChildren'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatUsageLimitActionsProvider } from './usage/NativeChatUsageLimitActions'
import type { ComponentProps, ReactNode, Ref } from 'react'
import { NativeChatMessageList } from './NativeChatMessageList'
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
  ComponentProps<typeof NativeChatMessageList>,
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
          <NativeChatMessageList
            {...props}
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
        </NativeChatHostSetupContext.Provider>
      </NativeChatUsageLimitActionsProvider>
    </NativeChatRowActionsProvider>
  )
}

export function NativeChatStructuredTranscriptFrame({
  pane,
  composerRef,
  canMention,
  isVisible,
  children
}: {
  pane: Omit<NativeChatStructuredViewProps, 'mode'>
  composerRef: ComponentProps<typeof NativeChatCrewPanel>['composerRef']
  canMention: boolean
  isVisible: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatCrewFrame
      panel={<NativeChatCrewPanel {...pane} {...{ composerRef, canMention, isVisible }} />}
    >
      <NativeChatSessionChildren {...pane} isVisible={isVisible} />
      {children}
    </NativeChatCrewFrame>
  )
}
