import { isTuiAgent } from './tui-agent-config'
import { tokenizeCustomCommandTemplate } from './commit-message-prompt'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import type { AgentLaunchProfile, TuiAgent } from './types'

export type AgentLaunchProfileSelectionKind = 'explicit' | 'stored-default'

export type AgentLaunchProfileResolution =
  | { ok: true; profile: AgentLaunchProfile; isDefaultProfile: boolean }
  | { ok: false; error: string }

export type AgentLaunchProfileStartupOptions =
  | {
      ok: true
      agent: TuiAgent
      cmdOverrides: Partial<Record<TuiAgent, string>>
      agentArgs: string
      agentEnv: Record<string, string>
      profile: AgentLaunchProfile
      isDefaultProfile: boolean
    }
  | { ok: false; error: string }

const SHELL_CONTROL_PATTERN = /[;&|<>()`$\n\r]/

export function getDefaultAgentLaunchProfileId(agent: TuiAgent): string {
  return `default:${agent}`
}

export function normalizeAgentLaunchProfiles(value: unknown): AgentLaunchProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const profiles: AgentLaunchProfile[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const profile = normalizeAgentLaunchProfile(entry)
    if (!profile || seen.has(profile.id)) {
      continue
    }
    seen.add(profile.id)
    profiles.push(profile)
  }
  return profiles
}

export function resolveAgentLaunchProfile(args: {
  agent: TuiAgent
  profileId?: string | null
  selectionKind?: AgentLaunchProfileSelectionKind
  profiles?: readonly AgentLaunchProfile[] | null
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentLaunchProfileResolution {
  const defaultProfile = buildDefaultAgentLaunchProfile(args)
  const requestedId = args.profileId?.trim()
  if (!requestedId || requestedId === defaultProfile.id) {
    return { ok: true, profile: defaultProfile, isDefaultProfile: true }
  }
  const profiles = normalizeAgentLaunchProfiles(args.profiles)
  const profile = profiles.find((entry) => entry.id === requestedId)
  if (!profile) {
    return handleUnavailableProfile(args, `Agent launch profile "${requestedId}" was not found.`)
  }
  if (profile.agentId !== args.agent) {
    return handleUnavailableProfile(
      args,
      `Agent launch profile "${requestedId}" belongs to ${profile.agentId}, not ${args.agent}.`
    )
  }
  if (profile.disabled) {
    return handleUnavailableProfile(args, `Agent launch profile "${profile.name}" is disabled.`)
  }
  const commandError = getProfileCommandOverrideError(profile)
  if (commandError) {
    return { ok: false, error: commandError }
  }
  return {
    ok: true,
    profile: mergeProfileWithCompatibilityDefaults(profile, args),
    isDefaultProfile: false
  }
}

export function resolveAgentLaunchProfileStartupOptions(args: {
  agent: TuiAgent
  profileId?: string | null
  selectionKind?: AgentLaunchProfileSelectionKind
  profiles?: readonly AgentLaunchProfile[] | null
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentLaunchProfileStartupOptions {
  const resolved = resolveAgentLaunchProfile(args)
  if (!resolved.ok) {
    return resolved
  }
  const cmdOverrides = resolved.profile.commandOverride
    ? { [args.agent]: resolved.profile.commandOverride }
    : {}
  return {
    ok: true,
    agent: args.agent,
    cmdOverrides,
    agentArgs: resolved.profile.args ?? '',
    agentEnv: { ...resolved.profile.env },
    profile: resolved.profile,
    isDefaultProfile: resolved.isDefaultProfile
  }
}

function normalizeAgentLaunchProfile(value: unknown): AgentLaunchProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!id || !name || !isTuiAgent(record.agentId)) {
    return null
  }
  const env = normalizeProfileEnv(record.env)
  return {
    id,
    agentId: record.agentId,
    name,
    ...normalizeStringField('commandOverride', record.commandOverride),
    ...normalizeProfileArgs(record.agentId, record.args),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(record.disabled === true ? { disabled: true } : {}),
    ...(record.protected === true ? { protected: true } : {})
  }
}

function normalizeStringField(
  key: 'commandOverride',
  value: unknown
): Partial<Pick<AgentLaunchProfile, 'commandOverride'>> {
  if (typeof value !== 'string') {
    return {}
  }
  return { [key]: value.trim() }
}

function normalizeProfileArgs(
  agent: TuiAgent,
  value: unknown
): Partial<Pick<AgentLaunchProfile, 'args'>> {
  if (typeof value !== 'string') {
    return {}
  }
  const normalized = normalizeTuiAgentArgsRecord({ [agent]: value })
  return { args: normalized[agent] ?? '' }
}

function normalizeProfileEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const env: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.trim()
    if (!key || typeof rawValue !== 'string') {
      continue
    }
    env[key] = rawValue
  }
  return env
}

function buildDefaultAgentLaunchProfile(args: {
  agent: TuiAgent
  agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
  agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
  agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
}): AgentLaunchProfile {
  const commandOverride = args.agentCmdOverrides?.[args.agent]?.trim()
  return {
    id: getDefaultAgentLaunchProfileId(args.agent),
    agentId: args.agent,
    name: 'Default',
    protected: true,
    ...(commandOverride ? { commandOverride } : {}),
    args: resolveTuiAgentLaunchArgs(args.agent, normalizeTuiAgentArgsRecord(args.agentDefaultArgs)),
    env: resolveTuiAgentLaunchEnv(args.agent, normalizeTuiAgentEnvRecord(args.agentDefaultEnv))
  }
}

function mergeProfileWithCompatibilityDefaults(
  profile: AgentLaunchProfile,
  args: {
    agent: TuiAgent
    agentCmdOverrides?: Partial<Record<TuiAgent, string>> | null
    agentDefaultArgs?: Partial<Record<TuiAgent, string>> | null
    agentDefaultEnv?: Partial<Record<TuiAgent, Record<string, string>>> | null
  }
): AgentLaunchProfile {
  const defaultProfile = buildDefaultAgentLaunchProfile(args)
  return {
    ...profile,
    commandOverride: profile.commandOverride ?? defaultProfile.commandOverride,
    args: profile.args ?? defaultProfile.args,
    env: { ...defaultProfile.env, ...profile.env }
  }
}

function handleUnavailableProfile(
  args: { agent: TuiAgent; selectionKind?: AgentLaunchProfileSelectionKind },
  error: string
): AgentLaunchProfileResolution {
  if (args.selectionKind === 'stored-default') {
    return {
      ok: true,
      profile: buildDefaultAgentLaunchProfile(args),
      isDefaultProfile: true
    }
  }
  return { ok: false, error }
}

function getProfileCommandOverrideError(profile: AgentLaunchProfile): string | null {
  if (!profile.commandOverride) {
    return null
  }
  const tokens = tokenizeCustomCommandTemplate(profile.commandOverride)
  if (!tokens.ok) {
    return `Agent launch profile "${profile.name}" has an invalid command override: ${tokens.error}`
  }
  if (tokens.tokens.length !== 1) {
    // Why: named profiles are built-in-agent variants. Multi-token shell
    // recipes belong in Quick Commands, not the agent profile registry.
    return `Agent launch profile "${profile.name}" command override must be a single executable path.`
  }
  if (/["']/.test(profile.commandOverride)) {
    return `Agent launch profile "${profile.name}" command override must not be quoted.`
  }
  if (SHELL_CONTROL_PATTERN.test(tokens.tokens[0])) {
    return `Agent launch profile "${profile.name}" command override must not contain shell control characters.`
  }
  return null
}
