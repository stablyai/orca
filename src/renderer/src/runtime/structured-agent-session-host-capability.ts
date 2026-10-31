import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'

/** The host's answer, rejecting when it couldn't be read: for an action that must tell "this
 *  host can't" from "couldn't ask it" (a dropped connection is not an older host). */
export async function readStructuredAgentSessionHostSupport(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): Promise<boolean> {
  if (target.kind === 'local') {
    const capabilities =
      readLocalRuntimeCapabilitiesOrUnknown() ?? (await ensureLocalRuntimeCapabilities())
    if (!capabilities) {
      throw new Error('host capabilities unknown')
    }
    return capabilities.includes(capability)
  }
  return runtimeEnvironmentSupportsCapability(target.environmentId, capability)
}
