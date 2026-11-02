import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { NativeChatStructuredWorkerLifetimeStrip } from './NativeChatStructuredWorkerLifetimeStrip'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { StructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'

/** The strips on the composer's top edge: the thread goal, then a temporary worker's lifetime. */
export function NativeChatStructuredComposerTabStrips(props: {
  tabId: string
  threadGoal: StructuredAgentSessionThreadGoal | null | undefined
  transport: NativeChatStructuredComposerTransport
  isWorking: boolean
  isVisible: boolean
  turnId: string | null
  workingStartedAt: number | null | undefined
}): React.JSX.Element {
  return (
    <>
      <NativeChatStructuredGoalStrip {...props} sessionId={props.transport.sessionId} />
      <NativeChatStructuredWorkerLifetimeStrip
        tabId={props.tabId}
        transport={props.transport}
        isVisible={props.isVisible}
      />
    </>
  )
}

function NativeChatStructuredGoalStrip(props: {
  sessionId: string
  threadGoal: StructuredAgentSessionThreadGoal | null | undefined
  transport: NativeChatStructuredComposerTransport
  isWorking: boolean
  isVisible: boolean
  turnId: string | null
  workingStartedAt: number | null | undefined
}): React.JSX.Element | null {
  const { threadGoal, transport } = props
  if (!threadGoal?.goal) {
    return null
  }
  // A host held for its permission mode takes no turn, and resuming or clearing a goal starts one.
  const startsHeld = transport.sendBlockedReason !== undefined
  return (
    <NativeChatThreadGoalBanner
      key={props.sessionId}
      goal={threadGoal.goal}
      pending={threadGoal.pending}
      hostChanges={threadGoal.hostChanges}
      sendUnavailable={transport.sendOut === true || props.isWorking}
      startsHeld={startsHeld}
      isVisible={props.isVisible}
      runningTurn={props.turnId === null ? null : { startedAt: props.workingStartedAt ?? null }}
      onChange={(change) => {
        const startsTurn =
          change.kind === 'set' ||
          (change.kind === 'status' && change.status === 'active') ||
          (change.kind === 'clear' && !threadGoal.hostChanges)
        if (startsHeld && startsTurn) {
          return
        }
        if (change.kind === 'clear' && !threadGoal.hostChanges) {
          transport.onSubmitted?.()
        }
        void threadGoal.change(change)
      }}
    />
  )
}
