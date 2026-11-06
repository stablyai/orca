import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { StructuredAgentSessionHostCapabilityState } from '../../../shared/agent-session/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'

/** Read a capability through the runtime's existing status cache. A failed/unknown
 *  probe is treated as legacy so a newer call is never made before the host has
 *  proved it understands it. */
export async function structuredAgentSessionHostSupports(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): Promise<boolean> {
  return (await structuredAgentSessionHostCapabilityState(target, capability)) === 'supported'
}

/** The same read, keeping a failed or unanswered probe (`unknown`) apart from a host that
 *  answered without the capability, for a decision an unverified host must not pass. */
export async function structuredAgentSessionHostCapabilityState(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): Promise<StructuredAgentSessionHostCapabilityState> {
  try {
    if (target.kind !== 'local') {
      const supported = await runtimeEnvironmentSupportsCapability(target.environmentId, capability)
      return supported ? 'supported' : 'unsupported'
    }
    const capabilities =
      readLocalRuntimeCapabilitiesOrUnknown() ?? (await ensureLocalRuntimeCapabilities())
    return capabilities?.includes(capability)
      ? 'supported'
      : capabilities
        ? 'unsupported'
        : 'unknown'
  } catch {
    return 'unknown'
  }
}
