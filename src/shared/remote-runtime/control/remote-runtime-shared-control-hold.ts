import type { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'
import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import {
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
} from '../recipe-vm-wake'
import {
  RUNTIME_IDLE_STOPPED_ERROR_CODE,
  RUNTIME_IDLE_STOPPED_MESSAGE
} from '../orcad-lifecycle/orcad-idle-stop-signal'
import type { RemoteRuntimeSharedControlConnectionOptions } from './remote-runtime-shared-control-types'

type HoldOptions = Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  'isManuallyDisconnected' | 'prepareSleepCheck' | 'isIdleStopped'
>

/** A socket that closed is not retried while the user disconnected the server, its VM sleeps
 *  (a retry would be the dial that wakes it, #36363) or it stopped idle (it would relaunch it). */
export async function prepareRetryHold(options: HoldOptions): Promise<() => boolean> {
  const asleep = await options.prepareSleepCheck?.()
  return () =>
    (options.isManuallyDisconnected?.() ?? false) ||
    (asleep?.() ?? false) ||
    (options.isIdleStopped?.() ?? false)
}

/** Why an open may not dial now, or null when it may: a closed connection, or a sleeping VM
 *  (which also covers a retry timer armed before the sleep and every wait for ready). */
export async function prepareOpenRefusal(
  intentionallyClosed: boolean,
  options: HoldOptions
): Promise<() => RemoteRuntimeClientError | null> {
  const asleep = await options.prepareSleepCheck?.()
  return () => {
    if (intentionallyClosed) {
      return remoteRuntimeUnavailableError()
    }
    if (options.isIdleStopped?.()) {
      return new RemoteRuntimeClientError(
        RUNTIME_IDLE_STOPPED_ERROR_CODE,
        RUNTIME_IDLE_STOPPED_MESSAGE
      )
    }
    if (asleep?.()) {
      return new RemoteRuntimeClientError(
        RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
        RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
      )
    }
    return null
  }
}

export function schedulePreparedControlRetry(
  options: RemoteRuntimeSharedControlConnectionOptions,
  args: {
    current: () => boolean
    subscriptionCount: () => number
    reconnect: SharedControlReconnectScheduler
    open: () => void
    publish: () => void
  }
): void {
  void prepareRetryHold(options)
    .then((held) => {
      if (!args.current()) {
        return
      }
      args.reconnect.scheduleAfterSocketClose({
        intentionallyClosed: false,
        manuallyDisconnected: held(),
        capabilityPaused: options.isCapabilityPaused?.() ?? false,
        subscriptionCount: args.subscriptionCount(),
        open: args.open
      })
      args.publish()
    })
    .catch(() => {})
}
