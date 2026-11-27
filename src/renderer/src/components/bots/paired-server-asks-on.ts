import {
  ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY,
  ORCHESTRATION_RUNTIME_CAPABILITIES
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'

/** Whether this computer's Orca takes asks from paired servers' agents: it advertises the capability. */
export function pairedServerAsksOn(): boolean {
  const advertised: readonly string[] = ORCHESTRATION_RUNTIME_CAPABILITIES
  return advertised.includes(ORCHESTRATION_CLIENT_AGENT_ASKS_RUNTIME_CAPABILITY)
}
