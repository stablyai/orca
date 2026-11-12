import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import {
  RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
  RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
} from '../recipe-vm-wake'
import type { RemoteRuntimeSharedControlConnectionOptions } from './remote-runtime-shared-control-types'

type HoldOptions = Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  'isManuallyDisconnected' | 'isAsleep'
>

/** A socket that closed is not retried while the user disconnected the server or its VM sleeps:
 *  a retry would be the dial that wakes a sleeping VM (#36363). */
export function isRetryHeld(options: HoldOptions): boolean {
  return (options.isManuallyDisconnected?.() ?? false) || (options.isAsleep?.() ?? false)
}

/** Why an open may not dial now, or null when it may: a closed connection, or a sleeping VM
 *  (which also covers a retry timer armed before the sleep and every wait for ready). */
export function openRefusal(
  intentionallyClosed: boolean,
  options: HoldOptions
): RemoteRuntimeClientError | null {
  if (intentionallyClosed) {
    return remoteRuntimeUnavailableError()
  }
  if (options.isAsleep?.()) {
    return new RemoteRuntimeClientError(
      RUNTIME_ENVIRONMENT_ASLEEP_ERROR_CODE,
      RUNTIME_ENVIRONMENT_ASLEEP_MESSAGE
    )
  }
  return null
}
