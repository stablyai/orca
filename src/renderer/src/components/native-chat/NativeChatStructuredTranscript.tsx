import { NativeChatUsageLimitActionsProvider } from './NativeChatUsageLimitActions'
import type { ComponentProps, Ref } from 'react'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatClaudeSignInContext } from './native-chat-claude-sign-in'
import type { useNativeChatClaudeSignIn } from './native-chat-claude-sign-in'
import type { useNativeChatInterruptedContinuation } from './NativeChatInterruptedContinue'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'

export function NativeChatStructuredTranscript({
  pane,
  directory,
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
  pane: ComponentProps<typeof NativeChatUsageLimitActionsProvider>['pane']
  directory: ComponentProps<typeof NativeChatUsageLimitActionsProvider>['directory']
  controller: ReturnType<typeof useStructuredAgentSession>
  continuation: ReturnType<typeof useNativeChatInterruptedContinuation>['view']
  claudeSignIn: ReturnType<typeof useNativeChatClaudeSignIn>
  messageListRef: Ref<NativeChatMessageListHandle>
}): React.JSX.Element {
  return (
    <NativeChatRewindContext.Provider value={controller.rewind.surface}>
      <NativeChatUsageLimitActionsProvider
        recovery={controller}
        pane={pane}
        directory={directory}
        messages={controller.messages}
        view={continuation}
      >
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
      </NativeChatUsageLimitActionsProvider>
    </NativeChatRewindContext.Provider>
  )
}
