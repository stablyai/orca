import { normalizeAgentLaunchProfiles } from '../../../../shared/agent-launch-profiles'
import type { AgentLaunchProfile, TuiAgent } from '../../../../shared/types'

export type AgentLaunchProfileDraft = {
  agentId: TuiAgent
  name: string
  commandOverride: string
  args: string
  envText: string
}

export const EMPTY_PROFILE_DRAFT: AgentLaunchProfileDraft = {
  agentId: 'codex',
  name: '',
  commandOverride: '',
  args: '',
  envText: ''
}

function slugProfileName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile'
  )
}

export function formatAgentLaunchProfileEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

export function parseAgentLaunchProfileEnv(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    const separator = line.indexOf('=')
    const key = (separator >= 0 ? line.slice(0, separator) : line).trim()
    if (!key) {
      continue
    }
    env[key] = separator >= 0 ? line.slice(separator + 1) : ''
  }
  return env
}

export function agentLaunchProfileToDraft(profile: AgentLaunchProfile): AgentLaunchProfileDraft {
  return {
    agentId: profile.agentId,
    name: profile.name,
    commandOverride: profile.commandOverride ?? '',
    args: profile.args ?? '',
    envText: formatAgentLaunchProfileEnv(profile.env)
  }
}

export function createAgentLaunchProfileId(args: {
  agentId: TuiAgent
  name: string
  profiles: readonly AgentLaunchProfile[]
}): string {
  const base = `${args.agentId}:${slugProfileName(args.name)}`
  const existingIds = new Set(args.profiles.map((profile) => profile.id))
  if (!existingIds.has(base)) {
    return base
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!existingIds.has(candidate)) {
      return candidate
    }
  }
}

export function buildAgentLaunchProfileFromDraft(args: {
  id: string
  draft: AgentLaunchProfileDraft
}): AgentLaunchProfile | null {
  const name = args.draft.name.trim()
  if (!name) {
    return null
  }
  const commandOverride = args.draft.commandOverride.trim()
  const agentArgs = args.draft.args.trim()
  const env = parseAgentLaunchProfileEnv(args.draft.envText)
  return {
    id: args.id,
    agentId: args.draft.agentId,
    name,
    ...(commandOverride ? { commandOverride } : {}),
    ...(agentArgs ? { args: agentArgs } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {})
  }
}

export function upsertAgentLaunchProfile(
  profiles: readonly AgentLaunchProfile[],
  profile: AgentLaunchProfile
): AgentLaunchProfile[] {
  const normalized = normalizeAgentLaunchProfiles(profiles)
  const index = normalized.findIndex((entry) => entry.id === profile.id)
  if (index < 0) {
    return normalizeAgentLaunchProfiles([...normalized, profile])
  }
  return normalizeAgentLaunchProfiles([
    ...normalized.slice(0, index),
    profile,
    ...normalized.slice(index + 1)
  ])
}

export function deleteAgentLaunchProfile(
  profiles: readonly AgentLaunchProfile[],
  profileId: string
): AgentLaunchProfile[] {
  return normalizeAgentLaunchProfiles(profiles).filter((profile) => profile.id !== profileId)
}
