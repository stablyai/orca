import { agentStopDisplayStatus } from '../../../../shared/agent-status/lifecycle/agent-stop-display-status'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { NativeChatAfterStopSend } from './native-chat-composer-target'

type StopController = Pick<
  ReturnType<typeof useStructuredAgentSession>,
  'canStop' | 'stopPressed' | 'stop' | 'queuedMessages' | 'sendsQueue' | 'queueSendsNext'
>

/** Bridge host Stopping with the local request; hold Stop only in flight so repeats can escalate, and queue sends for afterward. */
export function nativeChatStructuredStopControls(
  controller: StopController,
  hostStopping: boolean
): {
  stopping: boolean
  composer: {
    isWorking: boolean
    isStopping: boolean
    onStop: (() => void) | undefined
    steerHead: (() => boolean) | undefined
    steerLast: (() => boolean) | undefined
    afterStop: NativeChatAfterStopSend | undefined
  }
} {
  const stopping =
    agentStopDisplayStatus({
      working: controller.canStop,
      hostStopping,
      stopPressed: controller.stopPressed
    }) === 'stopping'
  const stopInFlight = controller.canStop && controller.stopPressed
  return {
    stopping,
    composer: {
      // Stop is offered whenever the chat looks busy, live only once a turn can be stopped.
      isWorking: controller.canStop || controller.queueSendsNext,
      isStopping: stopInFlight,
      onStop: controller.canStop ? () => void (stopInFlight || controller.stop()) : undefined,
      steerHead: stopping ? undefined : controller.queuedMessages.steerHead,
      steerLast: stopping ? undefined : controller.queuedMessages.steerLast,
      afterStop: stopping ? (controller.sendsQueue ? 'queue' : 'send') : undefined
    }
  }
}

type Session = ReturnType<typeof useStructuredAgentSession>

/** Cancel the shown prompt at its revision; the host routes a card with no running turn. */
export function cancelStructuredPrompt(
  controller: Pick<Session, 'cancel' | 'turnId'>,
  prompt: Session['prompts'][number] | null
): void {
  if (prompt) {
    void controller.cancel(controller.turnId ?? undefined, {
      itemId: prompt.itemId,
      expectedRevision: prompt.revision
    })
  }
}
