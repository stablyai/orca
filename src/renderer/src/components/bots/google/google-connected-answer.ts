// How a Connect card tells the bot it signed an account in: a hidden card answer, or, on a host from
// before google.bot.connected, the typed line those hosts' bots still expect.
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { GOOGLE_CONNECTED_ANSWER_RUNTIME_CAPABILITY } from '../../../../../shared/google/google-connect-types'

export async function googleConnectedAnswerIsHidden(target: RuntimeClientTarget): Promise<boolean> {
  return (
    target.kind === 'local' ||
    runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GOOGLE_CONNECTED_ANSWER_RUNTIME_CAPABILITY
    )
  )
}

/** Tells the bot the way its host takes it. A failed check goes to `failed`, never thrown, since the
 *  card's sign-in runs unawaited. */
export async function tellGoogleConnected(
  target: RuntimeClientTarget,
  ways: { hidden: () => void; typed: () => void; failed: (error: unknown) => void }
): Promise<void> {
  let hidden: boolean
  try {
    hidden = await googleConnectedAnswerIsHidden(target)
  } catch (error) {
    ways.failed(error)
    return
  }
  if (hidden) {
    ways.hidden()
  } else {
    ways.typed()
  }
}
