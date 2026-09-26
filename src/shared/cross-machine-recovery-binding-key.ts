import {
  agentProviderSessionIdentity,
  type AgentProviderSessionKey,
  type ResumableTuiAgent
} from './agent-session-resume'
import type {
  CrossMachineRecoveryErrorCode,
  RecoveryAgentBinding,
  RecoveryProviderSession
} from './cross-machine-recovery-descriptor'

/** Provider-session identity of one recovery binding. Its canonical string is the renderer's
 *  sleeping-pane claim key without the worktree, so transcriptPath counts only for pi/prime-agent. */
export type RecoveryBindingKey = {
  agent: ResumableTuiAgent
  key: AgentProviderSessionKey
  id: string
  transcriptPath?: string
}

/** A binding key, or a bare provider session id that must name exactly one binding. */
export type RecoveryBindingSelector = RecoveryBindingKey | string

export type RecoveryOmittedBinding = {
  agent: ResumableTuiAgent
  key: AgentProviderSessionKey
  id: string
  reason: 'agent-not-supported-v1'
}

export type RecoveryBindingSelection<T> =
  | { ok: true; binding: T }
  | {
      ok: false
      code: Extract<
        CrossMachineRecoveryErrorCode,
        'recovery_binding_not_found' | 'recovery_binding_ambiguous'
      >
    }

type KeyedBinding = { agent: ResumableTuiAgent; providerSession: RecoveryProviderSession }

export const RECOVERY_V1_EXPORT_AGENTS: readonly ResumableTuiAgent[] = ['claude']

export function recoveryBindingKeyOf(binding: KeyedBinding): RecoveryBindingKey {
  return { agent: binding.agent, ...binding.providerSession }
}

export function recoveryBindingKeyString(key: RecoveryBindingKey): string {
  return agentProviderSessionIdentity(key.agent, key)
}

export function selectRecoveryBinding<T extends KeyedBinding>(
  bindings: readonly T[],
  selector: RecoveryBindingSelector
): RecoveryBindingSelection<T> {
  const wanted = typeof selector === 'string' ? null : recoveryBindingKeyString(selector)
  const [binding, ...others] = bindings.filter((candidate) =>
    wanted === null
      ? candidate.providerSession.id === selector
      : recoveryBindingKeyString(recoveryBindingKeyOf(candidate)) === wanted
  )
  if (!binding) {
    return { ok: false, code: 'recovery_binding_not_found' }
  }
  return others.length > 0
    ? { ok: false, code: 'recovery_binding_ambiguous' }
    : { ok: true, binding }
}

function outranks(candidate: RecoveryAgentBinding, current: RecoveryAgentBinding): boolean {
  const candidateLive = candidate.liveness === 'live'
  const currentLive = current.liveness === 'live'
  return candidateLive === currentLive ? candidate.updatedAt > current.updatedAt : candidateLive
}

/** One binding per binding key (live, then newest, wins), limited to the agents v1 exports. */
export function projectV1RecoveryBindings(candidates: readonly RecoveryAgentBinding[]): {
  bindings: RecoveryAgentBinding[]
  omittedBindings: RecoveryOmittedBinding[]
} {
  const byKey = new Map<string, RecoveryAgentBinding>()
  for (const candidate of candidates) {
    const keyString = recoveryBindingKeyString(recoveryBindingKeyOf(candidate))
    const current = byKey.get(keyString)
    if (!current || outranks(candidate, current)) {
      byKey.set(keyString, candidate)
    }
  }
  const bindings: RecoveryAgentBinding[] = []
  const omittedBindings: RecoveryOmittedBinding[] = []
  for (const binding of byKey.values()) {
    if (RECOVERY_V1_EXPORT_AGENTS.includes(binding.agent)) {
      bindings.push(binding)
      continue
    }
    const { key, id } = binding.providerSession
    omittedBindings.push({ agent: binding.agent, key, id, reason: 'agent-not-supported-v1' })
  }
  return { bindings, omittedBindings }
}
