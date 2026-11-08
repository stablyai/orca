import type { RestoreSpawnIntent } from '../../../../../shared/host-spawn-admission'
import '../../../../../shared/protocol-version'
import { TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY } from '../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

/** The restore intent param for a remote create; empty for hosts whose strict params would reject it. */
export async function remoteRestoreSpawnIntentParams(
  environmentId: string,
  intent: RestoreSpawnIntent | undefined
): Promise<{ spawnIntent?: RestoreSpawnIntent }> {
  if (!intent) {
    return {}
  }
  try {
    return (await runtimeEnvironmentSupportsCapability(
      environmentId,
      TERMINAL_SPAWN_INTENT_RUNTIME_CAPABILITY
    ))
      ? { spawnIntent: intent }
      : {}
  } catch {
    // Why: a failed read-only probe proves nothing; an undeclared restore is only ever paced.
    return {}
  }
}
