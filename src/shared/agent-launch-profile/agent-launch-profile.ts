import { isTuiAgent } from '../tui-agent-config'
import type { TuiAgent } from '../tui-agent'

// An agent launch profile pins one launch of a CLI agent to a credential home
// and/or process-local overrides, so one host can run the same agent under
// several accounts or model providers at the same time. Selection is per launch,
// never a global slot, which is what lets two panes differ.

export const AGENT_LAUNCH_PROFILE_ID_MAX_LENGTH = 64
const AGENT_LAUNCH_PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const AGENT_LAUNCH_PROFILE_LABEL_MAX_LENGTH = 80
const AGENT_LAUNCH_PROFILE_ARGS_MAX_LENGTH = 4_000
const AGENT_LAUNCH_PROFILE_ENV_MAX_ENTRIES = 32
const AGENT_LAUNCH_PROFILE_ENV_VALUE_MAX_LENGTH = 4_000
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Env var each CLI reads its credential home from; the whole credential lives there. */
export type AgentLaunchProfileHomeEnvVar = 'CODEX_HOME' | 'CLAUDE_CONFIG_DIR'

export type AgentLaunchProfileHome = {
  envVar: AgentLaunchProfileHomeEnvVar
  /** Directory under the execution host's home when `overrideEnv` is unset. */
  dirName: string
  /** Host-side env var that relocates the directory (absolute path). */
  overrideEnv: string
}

export type AgentLaunchProfile = {
  id: string
  agent: TuiAgent
  label: string
  source: 'built-in' | 'custom'
  /** Appended after the agent's configured args; tokenized for the launch shell like `agentDefaultArgs`. */
  args?: string
  env?: Record<string, string>
  /** Present only for secondary-home profiles; resolved on the execution host. */
  home?: AgentLaunchProfileHome
}

/** Exported into every profile launch so hooks and status can attribute the pane. */
export const AGENT_LAUNCH_PROFILE_ENV = 'ORCA_AGENT_LAUNCH_PROFILE'

/** Marker carried by a launch; only the execution host turns it into a real path. */
export function agentLaunchProfileHomeMarkerEnv(envVar: AgentLaunchProfileHomeEnvVar): string {
  return `ORCA_${envVar}_PROFILE`
}

export const CODEX_SECONDARY_HOME_PROFILE_ID = 'codex-secondary-home'
export const CLAUDE_SECONDARY_HOME_PROFILE_ID = 'claude-secondary-home'

export const BUILT_IN_AGENT_LAUNCH_PROFILES: readonly AgentLaunchProfile[] = [
  {
    id: CODEX_SECONDARY_HOME_PROFILE_ID,
    agent: 'codex',
    label: 'Codex · secondary home',
    source: 'built-in',
    home: { envVar: 'CODEX_HOME', dirName: '.codex-2', overrideEnv: 'ORCA_CODEX_SECONDARY_HOME' }
  },
  {
    id: CLAUDE_SECONDARY_HOME_PROFILE_ID,
    agent: 'claude',
    label: 'Claude Code · secondary home',
    source: 'built-in',
    home: {
      envVar: 'CLAUDE_CONFIG_DIR',
      dirName: '.claude-2',
      overrideEnv: 'ORCA_CLAUDE_SECONDARY_HOME'
    }
  }
]

const BUILT_IN_IDS: ReadonlySet<string> = new Set(
  BUILT_IN_AGENT_LAUNCH_PROFILES.map((profile) => profile.id)
)

export function isAgentLaunchProfileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= AGENT_LAUNCH_PROFILE_ID_MAX_LENGTH &&
    AGENT_LAUNCH_PROFILE_ID_RE.test(value)
  )
}

/** User-defined profile as persisted in settings. Env values are plain strings, like `agentDefaultEnv`. */
export type AgentLaunchProfileSetting = {
  id: string
  agent: TuiAgent
  label?: string
  args?: string
  env?: Record<string, string>
}

function normalizeProfileEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const [rawName, raw] of Object.entries(value)) {
    const name = rawName.trim()
    if (
      !ENV_NAME_RE.test(name) ||
      typeof raw !== 'string' ||
      raw.length > AGENT_LAUNCH_PROFILE_ENV_VALUE_MAX_LENGTH ||
      Object.keys(env).length >= AGENT_LAUNCH_PROFILE_ENV_MAX_ENTRIES
    ) {
      continue
    }
    env[name] = raw
  }
  return Object.keys(env).length > 0 ? env : undefined
}

/** Drops malformed rows instead of failing the whole settings write; built-in ids cannot be shadowed. */
export function normalizeAgentLaunchProfileSettings(value: unknown): AgentLaunchProfileSetting[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const normalized: AgentLaunchProfileSetting[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') {
      continue
    }
    const candidate = row as Partial<AgentLaunchProfileSetting>
    if (
      !isAgentLaunchProfileId(candidate.id) ||
      BUILT_IN_IDS.has(candidate.id) ||
      seen.has(candidate.id) ||
      !isTuiAgent(candidate.agent)
    ) {
      continue
    }
    const label =
      typeof candidate.label === 'string' && candidate.label.trim()
        ? candidate.label.trim().slice(0, AGENT_LAUNCH_PROFILE_LABEL_MAX_LENGTH)
        : undefined
    const args =
      typeof candidate.args === 'string' && candidate.args.trim()
        ? candidate.args.trim().slice(0, AGENT_LAUNCH_PROFILE_ARGS_MAX_LENGTH)
        : undefined
    const env = normalizeProfileEnv(candidate.env)
    seen.add(candidate.id)
    normalized.push({
      id: candidate.id,
      agent: candidate.agent,
      ...(label ? { label } : {}),
      ...(args ? { args } : {}),
      ...(env ? { env } : {})
    })
  }
  return normalized
}

/** Built-ins first, then custom rows in settings order. */
export function resolveAgentLaunchProfiles(
  custom: readonly AgentLaunchProfileSetting[] | null | undefined
): AgentLaunchProfile[] {
  const customProfiles = (custom ?? []).map((row): AgentLaunchProfile => ({
    id: row.id,
    agent: row.agent,
    label: row.label ?? row.id,
    source: 'custom',
    ...(row.args ? { args: row.args } : {}),
    ...(row.env ? { env: { ...row.env } } : {})
  }))
  return [...BUILT_IN_AGENT_LAUNCH_PROFILES, ...customProfiles]
}

export function agentLaunchProfilesForAgent(
  profiles: readonly AgentLaunchProfile[],
  agent: TuiAgent
): AgentLaunchProfile[] {
  return profiles.filter((profile) => profile.agent === agent)
}

/** Null when the id is unknown or belongs to another agent; callers decide which error to raise. */
export function findAgentLaunchProfile(
  profiles: readonly AgentLaunchProfile[],
  agent: TuiAgent,
  id: string | null | undefined
): AgentLaunchProfile | null {
  if (!id) {
    return null
  }
  return profiles.find((profile) => profile.id === id && profile.agent === agent) ?? null
}

/** Layers a profile over the resolved launch args/env. Profile env wins over agent defaults. */
export function applyAgentLaunchProfile(opts: {
  profile: AgentLaunchProfile | null
  agentArgs: string
  agentEnv: Record<string, string>
}): { agentArgs: string; agentEnv: Record<string, string> } {
  const { profile, agentArgs, agentEnv } = opts
  if (!profile) {
    return { agentArgs, agentEnv }
  }
  return {
    agentArgs: [agentArgs.trim(), profile.args?.trim()].filter(Boolean).join(' '),
    agentEnv: {
      ...agentEnv,
      ...profile.env,
      [AGENT_LAUNCH_PROFILE_ENV]: profile.id,
      ...(profile.home
        ? { [agentLaunchProfileHomeMarkerEnv(profile.home.envVar)]: profile.id }
        : {})
    }
  }
}

/** Profile id a launch env carries, or null for a plain launch. */
export function agentLaunchProfileIdFromEnv(
  env: Record<string, string> | NodeJS.ProcessEnv | null | undefined
): string | null {
  const id = env?.[AGENT_LAUNCH_PROFILE_ENV]
  return isAgentLaunchProfileId(id) ? id : null
}

/** True when the launch asks the execution host to relocate this credential home. */
export function hasAgentLaunchProfileHomeMarker(
  env: Record<string, string> | NodeJS.ProcessEnv | null | undefined,
  envVar: AgentLaunchProfileHomeEnvVar
): boolean {
  return isAgentLaunchProfileId(env?.[agentLaunchProfileHomeMarkerEnv(envVar)])
}
