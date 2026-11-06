/** A launch's one opening message: its text, images, skills and files under the id its chat
 *  founds it with, saved as the launch's `firstMessage`. Having it never says who may send it: an
 *  ordinary create carries it in its payload, and a host launch hands it to its host at release. */

import type {
  StructuredAgentSessionCreateParams,
  StructuredAgentSessionFirstMessage
} from '../../../../../shared/agent-session/structured-agent-session-create'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

/** An ordinary create's payload apart from its opening, which only `opening` holds. */
export type StructuredLaunchCreateParams = Omit<StructuredAgentSessionCreateParams, 'firstMessage'>

type LaunchOpeningOwner = Pick<StructuredAgentSessionLaunchIntent, 'opening' | 'hostLaunch'>

/** The opening an ordinary create sends, which its recovery reads in the chat's journal and its
 *  retry sends again. A host launch has none: its host alone sends its opening. */
export function ordinaryLaunchOpening(
  intent: LaunchOpeningOwner
): StructuredAgentSessionFirstMessage | undefined {
  return intent.hostLaunch ? undefined : intent.opening
}

/** What an ordinary create sends: its payload, carrying its opening. */
export function structuredLaunchCreatePayload(
  intent: LaunchOpeningOwner & Pick<StructuredAgentSessionLaunchIntent, 'params'>
): StructuredAgentSessionCreateParams {
  const opening = ordinaryLaunchOpening(intent)
  return opening ? { ...intent.params, firstMessage: opening } : intent.params
}

/** Sets the create payload with its digest over everything create sends, opening included. */
export function sealStructuredLaunchCreatePayload(
  intent: LaunchOpeningOwner & Pick<StructuredAgentSessionLaunchIntent, 'params' | 'sessionId'>,
  params: StructuredLaunchCreateParams
): void {
  const opening = ordinaryLaunchOpening(intent)
  intent.params = {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: intent.sessionId,
        ...params,
        ...(opening ? { firstMessage: opening } : {})
      })
    }
  }
}

/** A host launch whose opening its host never acknowledged and the composer could not durably take
 *  back: only its saved row still holds it, so neither a shown chat nor a settled answer retires
 *  that row; the user's Close, Dismiss or the workspace's removal does. */
export function hostLaunchOwesOpening(launch: {
  cancelled: boolean
  intent: LaunchOpeningOwner
}): boolean {
  return (
    !launch.cancelled &&
    launch.intent.hostLaunch !== undefined &&
    launch.intent.opening !== undefined
  )
}
