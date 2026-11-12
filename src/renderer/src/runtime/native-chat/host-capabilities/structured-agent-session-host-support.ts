import '../../../../../shared/agent-session/agent-session-attention-capabilities'
import {
  AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import {
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import {
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/lifecycle/agent-session-stop-capabilities'
import {
  AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
} from '../../../../../shared/agent-session/agent-session-create-capabilities'
import '../../rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import {
  readLocalRuntimeCapabilitiesOrUnknown,
  ensureLocalRuntimeCapabilities
} from '../../hosts/capabilities/local-runtime-capabilities'
import '../../rpc/subscriptions/runtime-rpc-subscribe'
import '../requests/structured-agent-session-request-timeouts'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { RuntimeCapability } from '../../../../../shared/protocol-version'
import type { StructuredAgentSessionHostCapabilityState } from '../../../../../shared/agent-session/structured-agent-session-host-capability'

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

export function supportsStructuredAgentSessionContinuationContext(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_CONTINUATION_CONTEXT_RUNTIME_CAPABILITY
  )
}

export function supportsStructuredAgentSessionPromptCancel(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionCreateOptionsMode(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY
  )
}

export function supportsStructuredAgentSessionCreateMessage(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionCliSource(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY
  )
}

/** Whether the host writes no row for a Stop that stopped nothing, so a repeated Stop is quiet. */
export function supportsStructuredAgentSessionQuietRepeatedStop(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionQuestionAnswers(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY
  )
}

export function supportsStructuredAgentSessionItemDetail(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(target, AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)
}

export function supportsStructuredAgentSessionRegenerateName(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY
  )
}

/** Whether the owning host saves a chat's rename; an unproven host keeps it on the tab. */
export function supportsStructuredAgentSessionRename(
  target: RuntimeClientTarget
): Promise<boolean> {
  return structuredAgentSessionHostSupports(
    target,
    STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY
  )
}
