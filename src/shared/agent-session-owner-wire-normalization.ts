import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from './agent-session-host-authority'

const MAX_AGENT_SESSION_OWNER_BINDINGS = 1_024

export function normalizeAgentSessionOwnerBindings(
  value: unknown,
  entryId: string,
  context: string
): AgentSessionOwnerBinding[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SESSION_OWNER_BINDINGS) {
    throw new Error(`${context} agent owners are invalid`)
  }
  return value.map((owner) => normalizeAgentSessionOwnerBinding(owner, entryId, context))
}

function normalizeAgentSessionOwnerBinding(
  value: unknown,
  entryId: string,
  context: string
): AgentSessionOwnerBinding {
  const owner = requiredRecord(value, `${context} agent owner`)
  assertExactKeys(
    owner,
    ['claim', 'generation', 'phase', 'ptyId', 'surface'],
    `${context} agent owner`
  )
  const claim = requiredRecord(owner.claim, `${context} agent owner claim`)
  assertExactKeys(
    claim,
    ['digestVersion', 'keyId', 'identityDigest', 'worktreeScopeDigest', 'agent'],
    `${context} agent owner claim`
  )
  const surface = requiredRecord(owner.surface, `${context} agent owner surface`)
  assertExactKeys(
    surface,
    ['worktreeId', 'tabId', 'leafId', 'terminalHandle'],
    `${context} agent owner surface`
  )
  if (!isAgentSessionOwnerBinding(owner) || owner.ptyId !== entryId) {
    throw new Error(`${context} agent owner is invalid`)
  }
  return {
    claim: {
      digestVersion: owner.claim.digestVersion,
      keyId: owner.claim.keyId,
      identityDigest: owner.claim.identityDigest,
      worktreeScopeDigest: owner.claim.worktreeScopeDigest,
      agent: owner.claim.agent
    },
    generation: owner.generation,
    phase: owner.phase,
    ptyId: owner.ptyId,
    surface: {
      worktreeId: owner.surface.worktreeId,
      tabId: owner.surface.tabId,
      leafId: owner.surface.leafId,
      terminalHandle: owner.surface.terminalHandle
    }
  }
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  name: string
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error(`${name} contains an unknown field`)
  }
}
