import { agentStopDisplayStatus } from '../../../../shared/agent-stop-display-status'
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
    steerQueued: (() => boolean) | undefined
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
      steerQueued: stopping ? undefined : controller.queuedMessages.steerNewest,
      afterStop: stopping ? (controller.sendsQueue ? 'queue' : 'send') : undefined
    }
  }
}
