import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeOptionalField
} from './agent-status/contracts/agent-status-field-normalization'
import type { AgentSubagentSnapshot } from './agent-status/contracts/agent-status-subagent-snapshot'

const ANTIGRAVITY_SUBAGENT_ID_MAX_LENGTH = 64
const MAX_PENDING_ANTIGRAVITY_SPAWNS = 16

export type AntigravitySubagentIdentity = {
  agentType?: string
  description?: string
  model?: string
}

export type TrackedAntigravitySubagent = AntigravitySubagentIdentity & {
  state: 'working' | 'waiting'
  startedAt: number
}

export type AntigravityLeadStatus = {
  state: 'working' | 'waiting' | 'done'
  stateStartedAt: number
  heldOpenByHelpers: boolean
}

export type AntigravitySubagentRoster = {
  pendingSpawns: AntigravitySubagentIdentity[]
  knownIdentities: Map<string, AntigravitySubagentIdentity>
  children: Map<string, TrackedAntigravitySubagent>
  lead?: AntigravityLeadStatus
}

export function createAntigravitySubagentRoster(): AntigravitySubagentRoster {
  return {
    pendingSpawns: [],
    knownIdentities: new Map(),
    children: new Map()
  }
}

function normalizeAntigravityModel(raw: unknown): string | undefined {
  const normalized = normalizeOptionalField(raw, AGENT_MODEL_MAX_LENGTH)
  if (!normalized || normalized.toLowerCase() === 'inherit') {
    return undefined
  }
  return normalized
}

export function extractAntigravitySubagentSpawnIdentity(
  toolInputSource: unknown
): AntigravitySubagentIdentity | null {
  if (typeof toolInputSource !== 'object' || toolInputSource === null) {
    return null
  }
  const args = toolInputSource as Record<string, unknown>
  const agentType = normalizeOptionalField(
    args.TypeName ?? args.typeName ?? args.type_name,
    AGENT_TYPE_MAX_LENGTH
  )
  const role = normalizeOptionalField(args.Role ?? args.role, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const prompt = normalizeOptionalField(
    args.Prompt ?? args.prompt,
    AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
  )
  const model = normalizeAntigravityModel(args.Model ?? args.model)
  const description = role ?? prompt
  if (!agentType && !description && !model) {
    return null
  }
  return { agentType, description, model }
}

export function queueAntigravitySubagentSpawn(
  roster: AntigravitySubagentRoster,
  identity: AntigravitySubagentIdentity
): void {
  if (roster.pendingSpawns.length >= MAX_PENDING_ANTIGRAVITY_SPAWNS) {
    roster.pendingSpawns.shift()
  }
  roster.pendingSpawns.push(identity)
}

export function upsertAntigravitySubagent(
  roster: AntigravitySubagentRoster,
  conversationId: string,
  state: 'working' | 'waiting',
  now: number
): void {
  const normalizedId = conversationId.trim()
  if (normalizedId.length === 0 || normalizedId.length > ANTIGRAVITY_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const existing = roster.children.get(normalizedId)
  if (existing) {
    existing.state = state
    return
  }
  const known = roster.knownIdentities.get(normalizedId) ?? roster.pendingSpawns.shift()
  if (known) {
    roster.knownIdentities.set(normalizedId, known)
  }
  roster.children.set(normalizedId, {
    agentType: known?.agentType,
    description: known?.description,
    model: known?.model,
    state,
    startedAt: now
  })
}

export function finishAntigravitySubagent(
  roster: AntigravitySubagentRoster,
  conversationId: string
): void {
  roster.children.delete(conversationId.trim())
}

export function hasWaitingAntigravitySubagent(
  roster: AntigravitySubagentRoster | undefined
): boolean {
  if (!roster) {
    return false
  }
  for (const child of roster.children.values()) {
    if (child.state === 'waiting') {
      return true
    }
  }
  return false
}

export function antigravityRosterToSnapshots(
  roster: AntigravitySubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.children.size === 0) {
    return undefined
  }
  const snapshots: AgentSubagentSnapshot[] = Array.from(roster.children, ([id, tracked]) => ({
    id,
    ...(tracked.agentType ? { agentType: tracked.agentType } : {}),
    ...(tracked.description ? { description: tracked.description } : {}),
    ...(tracked.model ? { model: tracked.model } : {}),
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, 'en'))
  return snapshots
}
