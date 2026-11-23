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
