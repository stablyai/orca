import { agentStopDisplayStatus } from '../../../../shared/agent-stop-display-status'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { NativeChatAfterStopSend } from './native-chat-composer-target'

type StopController = Pick<
  ReturnType<typeof useStructuredAgentSession>,
  'canStop' | 'stopPressed' | 'stop' | 'queuedMessages' | 'sendsQueue' | 'queueSendsNext'
>

/**
 * The chat pane's Stop state. It reads "Stopping…" from the host's word, bridged by this client's
 * own press until its Stop event lands. Only that press in flight holds Stop, since a repeat is how
 * a stuck stop escalates. While it reads Stopping nothing steers into the turn: a message sent then
 * runs after it.
 */
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
