import {
  ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY,
  ORCHESTRATION_RUNTIME_CAPABILITIES,
  ORCHESTRATION_TEAMMATE_PEER_MAIL_RUNTIME_CAPABILITY
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { isSharedBotHostOnceListed } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'

/** Whether this computer's Orca takes asks from paired servers' agents: it advertises the capability. */
export function pairedServerAsksOn(): boolean {
  const advertised: readonly string[] = ORCHESTRATION_RUNTIME_CAPABILITIES
  return advertised.includes(ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY)
}

/** Whether a paired server's agents can message agents here; a shared agent's host must also take a
 *  teammate's mail, as `takesPeerMailFromHere` reads it in main. */
export async function serverAsksAgentsHere(environmentId: string): Promise<boolean> {
  const shared = await isSharedBotHostOnceListed(environmentId)
  const supported = await runtimeEnvironmentSupportsCapabilities(environmentId, [
    ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY,
    ...(shared ? [ORCHESTRATION_TEAMMATE_PEER_MAIL_RUNTIME_CAPABILITY] : [])
  ])
  return supported.every(Boolean)
}
