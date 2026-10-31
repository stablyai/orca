import { normalizeAgentLaunchChoices } from './agent-launch-choices'
import { agentPermissionHostPlatform, permissionEnvNameMatches } from './agent-permission-env'
import type { SleepingAgentLaunchConfig } from './agent-session-resume'
import type { GlobalSettings } from './global-settings-types'
import { isTuiAgent } from './tui-agent-config'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'
import {
  readLaunchPermissionChoice,
  type AgentPermissionChoice,
  agentPermissionEnv,
  hasTypedAgentPermission,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  sanitizeAgentPermissionUpdates
} from './tui-agent-permission-choice'
import { projectAgentLaunchProfile } from './agent-launch-profile'
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
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentLaunchChoices'
    | 'agentPermissionDefault'
    | 'agentPermissionOverrides'
    | 'terminalWindowsShell'
  >
>

/** Launch intent overrides only Orca's injected permission, preserving the user's args and env. */
export function agentLaunchPermissionSettings<T extends AgentLaunchProfileSettings>(
  agent: TuiAgent,
  settings: T,
  sessionOptions: Readonly<Record<string, unknown>> | undefined
) {
  const choice = readLaunchPermissionChoice(sessionOptions)
  return choice
    ? {
        ...settings,
        agentPermissionDefault: settings?.agentPermissionDefault ?? 'own',
        agentPermissionOverrides: { ...settings?.agentPermissionOverrides, [agent]: choice }
      }
    : settings
}

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

/** Read legacy startup argv so quoted prompt text and operands after -- cannot masquerade as permission flags. */
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
  // Some interactive agent commands removed, relocated or never supported these skip-permission flags.
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
  if ('agentLaunchChoices' in updates) {
    target.agentLaunchChoices = normalizeAgentLaunchChoices(updates.agentLaunchChoices)
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

export { agentPermissionArgsForLaunch } from './agent-permission-args'
/** Compose stored permission flags with user arguments, letting explicit user permission text win. Older host text already includes its flags. */
export function resolveTuiAgentLaunchArgs(
  agent: string,
  settings: AgentLaunchProfileSettings | null | undefined,
  permissionChoice?: AgentPermissionChoice,
  shell?: AgentStartupShell
): string {
  if (!isTuiAgent(agent)) {
    return ownArgs(agent, settings) ?? getTuiAgentDefaultArgs(agent)
  }
  return projectAgentLaunchProfile(agent, settings, {
    target: 'terminal',
    shell,
    ...(permissionChoice ? { choices: { permissionMode: permissionChoice } } : {})
  }).args
}

/** Original configured Arguments and permission, without fresh model defaults. */
export function resolveTuiAgentLaunchRawArgs(
  agent: string,
  settings: AgentLaunchProfileSettings | null | undefined,
  permissionChoice?: AgentPermissionChoice,
  shell?: AgentStartupShell
): string {
  return resolveTuiAgentLaunchArgs(
    agent,
    { ...settings, agentLaunchChoices: undefined },
    permissionChoice,
    shell
  )
}

/** Legacy missing Arguments use Orca’s bypass default; Manual stores an explicit empty value that overrides it. */
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

/** Publish composed args/env for older clients that infer permission from text; explicit keys prevent fallback to their built-in defaults. */
export function composeAgentLaunchProfile(
  settings: AgentLaunchProfileSettings,
  platform: NodeJS.Platform | null | undefined = agentPermissionHostPlatform()
): Required<Pick<AgentLaunchProfileSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> {
  if (!hasTypedAgentPermission(settings) && settings.agentLaunchChoices === undefined) {
    return {
      agentDefaultArgs: { ...settings.agentDefaultArgs },
      agentDefaultEnv: { ...settings.agentDefaultEnv }
    }
  }
  const argAgents = new Set([
    ...Object.keys(settings.agentDefaultArgs ?? {}),
    ...Object.keys(settings.agentLaunchChoices ?? {}),
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
      [...argAgents].map((agent) => [
        agent,
        resolveTuiAgentLaunchArgs(
          agent,
          settings,
          undefined,
          resolveStartupShell(
            platform ?? agentPermissionHostPlatform(),
            resolveLocalWindowsAgentStartupShell({
              platform: platform ?? agentPermissionHostPlatform(),
              isRemote: false,
              terminalWindowsShell: settings.terminalWindowsShell
            })
          )
        )
      ])
    ),
    agentDefaultEnv: Object.fromEntries(
      [...envAgents].map((agent) => [agent, resolveTuiAgentLaunchEnv(agent, settings, platform)])
    )
  }
}

/** Resume only the recorded recipe; defaults would grant bypass to unrecorded manual launches that never used it. */
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
