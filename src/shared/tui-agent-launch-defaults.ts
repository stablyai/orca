import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import {
  agentPermissionArgs,
  agentPermissionEnv,
  hasTypedAgentPermission,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  sanitizeAgentPermissionUpdates
} from './tui-agent-permission-choice'
import { agentArgsSetPermission } from './tui-agent-permission-lift'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'

const UNSUPPORTED_TUI_AGENT_ARGS: Partial<Record<TuiAgent, readonly string[]>> = {
  opencode: ['--dangerously-skip-permissions'],
  kilo: ['--dangerously-skip-permissions']
}

/** What a launch reads: the user's Arguments and env plus the stored permission choice. */
export type AgentLaunchProfileSettings = Partial<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionDefault' | 'agentPermissionOverrides'
  >
>

// What an untouched agent ran with before permissions were stored as a choice; legacy text only.
export const DEFAULT_TUI_AGENT_ARGS: Partial<Record<TuiAgent, string>> &
  Readonly<Record<string, string | undefined>> = YOLO_TUI_AGENT_ARGS

export const DEFAULT_TUI_AGENT_ENV: Partial<Record<string, Record<string, string>>> =
  YOLO_TUI_AGENT_ENV

function argPattern(arg: string): RegExp {
  return new RegExp(`(^|\\s)${arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g')
}

export function hasUnsupportedTuiAgentArgs(agent: TuiAgent, value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  return (UNSUPPORTED_TUI_AGENT_ARGS[agent] ?? []).some((arg) => argPattern(arg).test(value))
}

/**
 * Whether the configured arguments carry this agent's permission-bypass flag.
 *
 * Legacy profiles carry the permission in Arguments. Read the startup argv so quoted text and
 * operands after `--` cannot authorize a structured session.
 */
export function tuiAgentArgsBypassPermissions(
  agent: TuiAgent,
  value: string | null | undefined,
  shell: AgentStartupShell
): boolean {
  const bypassArg = YOLO_TUI_AGENT_ARGS[agent]
  if (typeof value !== 'string' || bypassArg === undefined) {
    return false
  }
  const tokenized = tokenizeStartupCommand(value, shell)
  const bypass = tokenizeStartupCommand(bypassArg, shell)
  if (!tokenized.ok || !bypass.ok || bypass.tokens.length === 0) {
    return false
  }
  const terminator = tokenized.tokens.indexOf('--')
  const options = terminator === -1 ? tokenized.tokens : tokenized.tokens.slice(0, terminator)
  // A token sequence: several agents' bypass is a flag and its value (`--permission-mode X`).
  return options.some((_, start) =>
    bypass.tokens.every((token, offset) => options[start + offset] === token)
  )
}

function sanitizeTuiAgentLaunchArgs(agent: TuiAgent, args: string): string {
  const unsupportedArgs = UNSUPPORTED_TUI_AGENT_ARGS[agent]
  if (!unsupportedArgs) {
    return args.trim()
  }
  // Why: a few agents have removed, relocated, or never exposed Claude-style
  // skip-permission flags on the interactive TUI command Orca launches.
  return unsupportedArgs.reduce((next, arg) => next.replace(argPattern(arg), ' '), args).trim()
}

export function normalizeTuiAgentArgsRecord(value: unknown): Partial<Record<TuiAgent, string>> {
  const normalized: Partial<Record<TuiAgent, string>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, args] of Object.entries(value)) {
    if (!isTuiAgent(agent) || typeof args !== 'string') {
      continue
    }
    normalized[agent] = sanitizeTuiAgentLaunchArgs(agent, args)
  }
  return normalized
}

export function normalizeTuiAgentEnvRecord(
  value: unknown
): Partial<Record<TuiAgent, Record<string, string>>> {
  const normalized: Partial<Record<TuiAgent, Record<string, string>>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, env] of Object.entries(value)) {
    if (!isTuiAgent(agent) || !env || typeof env !== 'object') {
      continue
    }
    const entries: [string, string][] = []
    for (const [name, raw] of Object.entries(env)) {
      const key = name.trim()
      if (!key || typeof raw !== 'string') {
        continue
      }
      entries.push([key, raw])
    }
    normalized[agent] = Object.fromEntries(entries)
  }
  return normalized
}

/** Normalizes a settings write's launch profile in place, wherever the write lands. */
export function sanitizeAgentLaunchProfileUpdates(
  target: Partial<GlobalSettings>,
  updates: Partial<GlobalSettings>
): void {
  if ('agentDefaultArgs' in updates) {
    target.agentDefaultArgs = normalizeTuiAgentArgsRecord(updates.agentDefaultArgs)
    target.agentYoloDefaultsMigrated = true
  }
  if ('agentDefaultEnv' in updates) {
    target.agentDefaultEnv = normalizeTuiAgentEnvRecord(updates.agentDefaultEnv)
    target.agentYoloDefaultsMigrated = true
  }
  sanitizeAgentPermissionUpdates(target, updates)
}

export function getTuiAgentDefaultArgs(agent: string): string {
  return DEFAULT_TUI_AGENT_ARGS[agent] ?? ''
}

export function getTuiAgentDefaultEnv(agent: string): Record<string, string> {
  return { ...DEFAULT_TUI_AGENT_ENV[agent] }
}

function ownArgs(agent: string, settings: AgentLaunchProfileSettings | null | undefined) {
  const configured = settings?.agentDefaultArgs
  const value: unknown = configured && Object.getOwnPropertyDescriptor(configured, agent)?.value
  return typeof value === 'string' ? value : undefined
}

/**
 * The Arguments a terminal launch of this agent gets: Orca's flag for the agent's stored
 * permission, then the user's own text. Text that sets permissions itself wins, so Orca adds none.
 * Settings without a stored choice (an older host's published text) already carry the flag.
 */
export function resolveTuiAgentLaunchArgs(
  agent: string,
  settings: AgentLaunchProfileSettings | null | undefined
): string {
  const own = ownArgs(agent, settings)
  if (!hasTypedAgentPermission(settings) || !isTuiAgent(agent)) {
    return own ?? getTuiAgentDefaultArgs(agent)
  }
  const user = own?.trim() ?? ''
  const flag = agentPermissionArgs(agent, resolveAgentPermission(agent, settings).choice)
  if (!flag || agentArgsSetPermission(agent, user)) {
    return user
  }
  return user ? `${flag} ${user}` : flag
}

/**
 * Whether this agent's *resolved* launch arguments ask for a permission bypass.
 *
 * Resolved, not configured: an untouched Arguments field falls back to the default Orca ships,
 * which is the bypass flag, so bypass is the posture a user gets until they choose otherwise.
 * Choosing Manual stores an empty string, which owns the key and so beats that default.
 */
export function resolvedTuiAgentArgsBypassPermissions(
  agent: TuiAgent,
  settings:
    | (AgentLaunchProfileSettings & Partial<Pick<GlobalSettings, 'terminalWindowsShell'>>)
    | null
    | undefined,
  platform: NodeJS.Platform
): boolean {
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote: false,
      terminalWindowsShell: settings?.terminalWindowsShell
    })
  )
  return tuiAgentArgsBypassPermissions(agent, resolveTuiAgentLaunchArgs(agent, settings), shell)
}

/** The env a terminal launch of this agent gets; the user's own entries win over Orca's. */
export function resolveTuiAgentLaunchEnv(
  agent: string,
  settings: AgentLaunchProfileSettings | null | undefined,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform(),
  visitBaseEntry?: (name: string, value: string) => true
): Record<string, string> {
  const configured = settings?.agentDefaultEnv
  const value: unknown = configured && Object.getOwnPropertyDescriptor(configured, agent)?.value
  const own =
    value && typeof value === 'object'
      ? Object.entries(value).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === 'string' && (visitBaseEntry?.(entry[0], entry[1]) ?? true)
        )
      : undefined
  if (!hasTypedAgentPermission(settings) || !isTuiAgent(agent)) {
    const entries = own ?? Object.entries(getTuiAgentDefaultEnv(agent))
    if (!own) {
      entries.forEach(([name, value]) => visitBaseEntry?.(name, value))
    }
    return Object.fromEntries(entries)
  }
  const added = Object.entries(
    agentPermissionEnv(agent, resolveAgentPermission(agent, settings).choice)
  ).filter(([name]) => !own?.some(([key]) => permissionEnvNameMatches(key, name, platform)))
  return Object.fromEntries(added.length ? [...added, ...(own ?? [])] : (own ?? []))
}

/**
 * Every agent's Arguments and env as its terminal launch gets them, flags included: what older
 * clients read, since they treat that text as the permission. Each permission agent gets a key so
 * an older client never falls back to its own built-in default.
 */
export function composeAgentLaunchProfile(
  settings: AgentLaunchProfileSettings,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): Required<Pick<AgentLaunchProfileSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> {
  if (!hasTypedAgentPermission(settings)) {
    return {
      agentDefaultArgs: { ...settings.agentDefaultArgs },
      agentDefaultEnv: { ...settings.agentDefaultEnv }
    }
  }
  const argAgents = new Set([
    ...Object.keys(settings.agentDefaultArgs ?? {}),
    ...PERMISSION_CHOICE_AGENTS
  ])
  const envAgents = new Set([
    ...Object.keys(settings.agentDefaultEnv ?? {}),
    ...PERMISSION_CHOICE_AGENTS.filter(
      (agent) => Object.keys(agentPermissionEnv(agent, 'full-access')).length > 0
    )
  ])
  return {
    agentDefaultArgs: Object.fromEntries(
      [...argAgents].map((agent) => [agent, resolveTuiAgentLaunchArgs(agent, settings)])
    ),
    agentDefaultEnv: Object.fromEntries(
      [...envAgents].map((agent) => [agent, resolveTuiAgentLaunchEnv(agent, settings, platform)])
    )
  }
}

/**
 * The command, args and env a resume relaunches with: only what its original Orca launch recorded.
 * Why not settings defaults: an unrecorded launch (`claude` typed by hand) ran with none, and the
 * defaults carry the permission bypass, so filling the gap would widen the resumed session.
 */
export function resolveResumeLaunchRecipe(
  launchConfig: SleepingAgentLaunchConfig | undefined
): SleepingAgentLaunchConfig {
  if (!launchConfig) {
    return { agentArgs: '', agentEnv: {} }
  }
  return {
    agentArgs: launchConfig.agentArgs,
    agentEnv: launchConfig.agentEnv,
    ...(launchConfig.agentCommand ? { agentCommand: launchConfig.agentCommand } : {}),
    ...(launchConfig.ompResumeFilePath ? { ompResumeFilePath: launchConfig.ompResumeFilePath } : {})
  }
}
