// Capability negotiation for identity-only agent launches (U3/U7). A pre-identity
// host's terminal.create params is a plain object schema, so it silently STRIPS
// the unknown `agentLaunch` key and spawns a bare login shell — and because the
// response still carries a terminal, the client would report a launched agent.
// Callers that keep a client-assembled command may degrade to it; the rest must
// refuse. Plain English, like the other host-version errors in protocol-compat.

import { AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

export const AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE =
  'The selected Orca server is too old to launch agents. Update Orca on the server.'

/** Throws when the runtime does not advertise agent-launch.identity.v1. */
export async function assertRuntimeSupportsAgentLaunchIdentity(
  environmentId: string
): Promise<void> {
  const supported = await runtimeEnvironmentSupportsCapability(
    environmentId,
    AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY
  )
  if (!supported) {
    throw new Error(AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)
  }
}

export type AgentLaunchIdentityArm = 'identity' | 'legacy'

/**
 * Negotiates before anything is spawned. Answers 'legacy' only when the caller
 * kept a client-assembled command to degrade to; otherwise refuses, so an
 * unsupported host can never answer with a bare shell reported as a launch.
 */
export async function negotiateAgentLaunchIdentityArm(
  environmentId: string,
  hasLegacyCommand: boolean
): Promise<AgentLaunchIdentityArm> {
  let supported: boolean
  try {
    supported = await runtimeEnvironmentSupportsCapability(
      environmentId,
      AGENT_LAUNCH_IDENTITY_RUNTIME_CAPABILITY
    )
  } catch (error) {
    // A failed read-only probe spawned nothing; only the legacy command is safe
    // to fall back to, and a version block must stay a version block.
    if (isRuntimeCompatBlockError(error) || !hasLegacyCommand) {
      throw error
    }
    return 'legacy'
  }
  if (supported) {
    return 'identity'
  }
  if (!hasLegacyCommand) {
    throw new Error(AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE)
  }
  return 'legacy'
}
