import { NativeChatThreadGoalBanner } from '../../session/goals/NativeChatThreadGoalBanner'
import type { StructuredAgentSessionThreadGoal } from '../../session/goals/use-structured-agent-session-thread-goal'
import type { NativeChatImageRuntimeContext } from '../../media/images/native-chat-image-runtime-context'
import { NativeChatTextAttachments } from '../../media/text/NativeChatTextAttachments'
import type { NativeChatStructuredComposerTransport } from '../../composer/submit/native-chat-structured-composer-transport'
import { NativeChatMcpTray } from '../../mcp/NativeChatMcpTray'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** The strips on the composer's top edge: the thread goal, then `/mcp`'s tray. */
export function NativeChatStructuredComposerTabStrips(props: {
  target: RuntimeClientTarget
  focusComposer: () => void
  runtimeContext: NativeChatImageRuntimeContext
  threadGoal: StructuredAgentSessionThreadGoal | null | undefined
  transport: NativeChatStructuredComposerTransport
  isWorking: boolean
  isVisible: boolean
  turnId: string | null
  workingStartedAt: number | null | undefined
}): React.JSX.Element {
  const mcpPanel = props.transport.mcpPanel
  return (
    <>
      <NativeChatStructuredGoalStrip {...props} sessionId={props.transport.sessionId} />
      {mcpPanel?.isOpen && !props.transport.sessionPending ? (
        <NativeChatMcpTray
          sessionId={props.transport.sessionId}
          target={props.target}
          agent={mcpPanel.agent}
          agentLabel={mcpPanel.agentLabel}
          opens={mcpPanel.opens}
          onClose={() => {
            mcpPanel.close()
            props.focusComposer()
          }}
        />
      ) : null}
    </>
  )
}

function NativeChatStructuredGoalStrip(props: {
  sessionId: string
  runtimeContext: NativeChatImageRuntimeContext
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
      objectiveContent={
        <NativeChatTextAttachments
          content={threadGoal.goal.objective}
          structured
          runtimeContext={props.runtimeContext}
          renderText={(text) => text}
        />
      }
      pending={threadGoal.pending}
      hostChanges={threadGoal.hostChanges}
      agentResumes={threadGoal.agentResumes}
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
        if (!threadGoal.hostChanges) {
          transport.onSubmitted?.()
        }
        void threadGoal.change(change)
      }}
    />
  )
}
