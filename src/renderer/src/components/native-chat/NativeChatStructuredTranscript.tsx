import type { ComponentProps, Ref } from 'react'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { NativeChatClaudeSignInContext } from './native-chat-claude-sign-in'
import type { useNativeChatClaudeSignIn } from './native-chat-claude-sign-in'
import type { useNativeChatInterruptedContinuation } from './NativeChatInterruptedContinue'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

export function NativeChatStructuredTranscript({
  controller,
  continuation,
  claudeSignIn,
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
  controller: ReturnType<typeof useStructuredAgentSession>
  continuation: ReturnType<typeof useNativeChatInterruptedContinuation>['view']
  claudeSignIn: ReturnType<typeof useNativeChatClaudeSignIn>
  messageListRef: Ref<NativeChatMessageListHandle>
}): React.JSX.Element {
  return (
    <NativeChatRewindContext.Provider value={controller.rewind.surface}>
      <NativeChatOrcaStopContext.Provider value={continuation}>
        <NativeChatClaudeSignInContext.Provider value={claudeSignIn}>
          <NativeChatMessageList
            {...props}
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
        </NativeChatClaudeSignInContext.Provider>
      </NativeChatOrcaStopContext.Provider>
    </NativeChatRewindContext.Provider>
  )
}
