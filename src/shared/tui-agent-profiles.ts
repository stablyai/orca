import { isBuiltInTuiAgent } from './tui-agent-config'
import { isTuiAgentProfileId, TUI_AGENT_PROFILE_ID_PREFIX } from './tui-agent-profile-id'
import type { BuiltInTuiAgent, TuiAgent, TuiAgentProfile, TuiAgentProfileId } from './types'

export type TuiAgentProfileVariables = {
  repoPath?: string | null
  worktreePath?: string | null
}

export function createTuiAgentProfileId(baseAgent: BuiltInTuiAgent): TuiAgentProfileId {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${TUI_AGENT_PROFILE_ID_PREFIX}${baseAgent}-${random}` as TuiAgentProfileId
}

function normalizeProfileEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim()
    if (!name || typeof rawValue !== 'string') {
      continue
    }
    env[name] = rawValue
  }
  return Object.keys(env).length > 0 ? env : undefined
}

function normalizeProfileLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const label = value.trim().replace(/\s+/g, ' ')
  return label.length > 0 ? label.slice(0, 80) : null
}

export function normalizeTuiAgentProfiles(value: unknown): TuiAgentProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const profiles: TuiAgentProfile[] = []
  const seenIds = new Set<TuiAgentProfileId>()
  const seenLabels = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const raw = item as Record<string, unknown>
    if (!isTuiAgentProfileId(raw.id) || seenIds.has(raw.id)) {
      continue
    }
    if (!isBuiltInTuiAgent(raw.baseAgent)) {
      continue
    }
    const label = normalizeProfileLabel(raw.label)
    if (!label) {
      continue
    }
    const labelKey = label.toLocaleLowerCase()
    if (seenLabels.has(labelKey)) {
      continue
    }
    seenIds.add(raw.id)
    seenLabels.add(labelKey)
    const defaultEnv = normalizeProfileEnv(raw.defaultEnv)
    profiles.push({
      id: raw.id,
      baseAgent: raw.baseAgent,
      label,
      ...(typeof raw.cmdOverride === 'string' && raw.cmdOverride.trim()
        ? { cmdOverride: raw.cmdOverride.trim() }
        : {}),
      ...(typeof raw.defaultArgs === 'string' ? { defaultArgs: raw.defaultArgs.trim() } : {}),
      ...(defaultEnv ? { defaultEnv } : {})
    })
  }
  return profiles
}

export function resolveTuiAgentBaseAgent(
  agent: TuiAgent,
  profiles?: readonly TuiAgentProfile[] | null
): BuiltInTuiAgent | null {
  if (isBuiltInTuiAgent(agent)) {
    return agent
  }
  return profiles?.find((profile) => profile.id === agent)?.baseAgent ?? null
}

export function findTuiAgentProfile(
  agent: TuiAgent,
  profiles?: readonly TuiAgentProfile[] | null
): TuiAgentProfile | null {
  if (!isTuiAgentProfileId(agent)) {
    return null
  }
  return profiles?.find((profile) => profile.id === agent) ?? null
}

export function interpolateTuiAgentProfileVariables(
  value: string,
  variables?: TuiAgentProfileVariables | null
): string {
  const repoPath = variables?.repoPath?.trim() ?? ''
  const worktreePath = variables?.worktreePath?.trim() ?? ''
  return value.replace(/\{repoPath\}/g, repoPath).replace(/\{worktreePath\}/g, worktreePath)
}

export function isTuiAgentProfileDetected(
  profile: TuiAgentProfile,
  detected: ReadonlySet<TuiAgent> | null
): boolean {
  return detected === null || detected.has(profile.baseAgent)
}
