import {
  AGENT_PERMISSION_ARG_SPECS,
  agentHasPermissionMode,
  resolveAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV,
  type AgentPermissionArgSpec,
  type AgentPermissionMode,
  type AgentPermissionOption
} from './tui-agent-permissions'
import {
  resolveAgentLaunchGrammar,
  tokenizeStartupCommand,
  type AgentLaunchTarget,
  type AgentStartupShell,
  type StartupCommandTokens
} from './tui-agent-startup-shell'
import type { AgentLaunchProfileSettings } from './tui-agent-launch-defaults'
import type { TuiAgent } from './tui-agent'

// Reads permission settings typed into an agent's free-text Arguments and env.

/** Tokens of free-text arguments under one grammar, up to any `--`. */
export function optionTokens(value: string, shell: AgentStartupShell): StartupCommandTokens {
  const tokenized = tokenizeStartupCommand(value, shell)
  if (!tokenized.ok) {
    return tokenized
  }
  // Why: operands after `--` are prompt text, never options.
  const terminator = tokenized.tokens.indexOf('--')
  return terminator === -1
    ? tokenized
    : {
        ok: true,
        tokens: tokenized.tokens.slice(0, terminator),
        spans: tokenized.spans.slice(0, terminator)
      }
}

function tokenizeFlag(flag: string | undefined): string[] {
  const tokenized = flag ? tokenizeStartupCommand(flag, 'posix') : null
  return tokenized?.ok ? tokenized.tokens : []
}

/** The permission options an agent's bypass flag sets, for agents with no wider table entry. */
function specFromBypassFlag(flag: readonly string[]): AgentPermissionArgSpec {
  const options: AgentPermissionOption[] = []
  const bypass: Record<string, string | true> = {}
  for (let index = 0; index < flag.length; index += 1) {
    const value = flag[index + 1]
    const takesValue = value !== undefined && !value.startsWith('-')
    options.push({ names: [flag[index]], takesValue })
    bypass[flag[index]] = takesValue ? value : true
    if (takesValue) {
      index += 1
    }
  }
  return { options, bypass: options.length > 0 ? [bypass] : [] }
}

const argSpecCache = new Map<TuiAgent, AgentPermissionArgSpec>()

function agentPermissionArgSpec(agent: TuiAgent): AgentPermissionArgSpec {
  let spec = argSpecCache.get(agent)
  if (!spec) {
    spec =
      AGENT_PERMISSION_ARG_SPECS[agent] ??
      specFromBypassFlag(tokenizeFlag(YOLO_TUI_AGENT_ARGS[agent]))
    argSpecCache.set(agent, spec)
  }
  return spec
}

/** The value this token gives `option`, `{}` when the value is the next token, or null if it is another word. */
function readOptionToken(
  option: AgentPermissionOption,
  token: string
): { value?: string | true } | null {
  for (const name of option.names) {
    if (token === name) {
      return option.takesValue ? {} : { value: true }
    }
    if (token.startsWith(`${name}=`)) {
      return { value: token.slice(name.length + 1) }
    }
    // Short options also take their value attached (`-anever`).
    if (/^-[a-zA-Z]$/.test(name) && token.startsWith(name)) {
      return { value: token.slice(name.length) }
    }
  }
  return null
}

type TypedPermissionSetting = { option: string; value: string | true; text: string }

// Reads the words the CLI receives: the launch strips quotes and re-quotes each word, so `"-a"` is `-a`.
function readTypedSettings(
  spec: AgentPermissionArgSpec,
  tokens: readonly string[]
): TypedPermissionSetting[] {
  const settings: TypedPermissionSetting[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    for (const option of spec.options) {
      const read = readOptionToken(option, token)
      if (!read) {
        continue
      }
      const next = read.value === undefined ? tokens[index + 1] : undefined
      settings.push({
        option: option.names[0],
        value: read.value ?? next ?? '',
        text: next === undefined ? token : `${token} ${next}`
      })
      if (next !== undefined) {
        index += 1
      }
      break
    }
  }
  return settings
}

export type TypedAgentPermissionKind = 'none' | 'bypass' | 'other'

function readKind(
  spec: AgentPermissionArgSpec,
  settings: readonly TypedPermissionSetting[]
): TypedAgentPermissionKind {
  if (settings.length === 0) {
    return 'none'
  }
  const typedBypasses = spec.bypass.filter((bypass) =>
    Object.entries(bypass).every(([option, value]) =>
      settings.some((setting) => setting.option === option && setting.value === value)
    )
  )
  // Bypass only when every typed setting belongs to a bypass typed in full (`-a never` alone asks).
  return typedBypasses.length > 0 &&
    settings.every((setting) =>
      typedBypasses.some((bypass) => bypass[setting.option] === setting.value)
    )
    ? 'bypass'
    : 'other'
}

/** Every grammar Orca launches with; the lift, which runs before any launch, checks them all. */
export const LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

/** One source's typed permission settings: what they add up to and the settings as written. */
type TypedSourcePermissions = { kind: TypedAgentPermissionKind; options: string[] }

export type TypedAgentPermissions = {
  kind: TypedAgentPermissionKind
  /** Permission settings typed into Arguments, as written, in order, for Settings to name. */
  argumentOptions: string[]
  /** Permission settings typed into the environment, as `NAME=value`. */
  environmentOptions: string[]
}

function classifyArgs(
  agent: TuiAgent,
  args: string,
  shell: AgentStartupShell
): TypedSourcePermissions {
  const spec = agentPermissionArgSpec(agent)
  // Text that shell can't parse can't launch, so it sets nothing.
  const tokens = args.trim() && spec.options.length > 0 ? optionTokens(args, shell) : null
  if (!tokens?.ok) {
    return { kind: 'none', options: [] }
  }
  const settings = readTypedSettings(spec, tokens.tokens)
  return { kind: readKind(spec, settings), options: settings.map((setting) => setting.text) }
}

function classifyEnv(agent: TuiAgent, env: Record<string, string>): TypedSourcePermissions {
  // Extra env overrides the mode's env (see resolveTuiAgentLaunchEnv), so a typed key decides.
  const typed = Object.keys(YOLO_TUI_AGENT_ENV[agent] ?? {}).filter((name) =>
    Object.hasOwn(env, name)
  )
  if (typed.length === 0) {
    return { kind: 'none', options: [] }
  }
  return {
    kind: Object.entries(YOLO_TUI_AGENT_ENV[agent] ?? {}).every(
      ([name, value]) => env[name] === value
    )
      ? 'bypass'
      : 'other',
    options: typed.map((name) => `${name}=${env[name]}`)
  }
}

/**
 * What permission settings typed into an agent's Arguments and env do, read with the shell that
 * launches them: nothing (its mode decides), bypass, or something else.
 */
export function classifyTypedAgentPermissions(
  agent: TuiAgent,
  typed: { args?: string | null; env?: Record<string, string> | null },
  shell: AgentStartupShell
): TypedAgentPermissions {
  const args = classifyArgs(agent, typed.args ?? '', shell)
  const env = classifyEnv(agent, typed.env ?? {})
  const kinds = [args.kind, env.kind].filter((kind) => kind !== 'none')
  return {
    kind:
      kinds.length === 0 ? 'none' : kinds.every((kind) => kind === 'bypass') ? 'bypass' : 'other',
    argumentOptions: args.options,
    environmentOptions: env.options
  }
}

/** Whether these arguments set this option at all, under any of these grammars. */
export function argumentsSetOption(
  args: string,
  option: string,
  grammars: readonly AgentStartupShell[]
): boolean {
  const spec: AgentPermissionOption = { names: [option], takesValue: true }
  return grammars.some((grammar) => {
    const tokens = optionTokens(args, grammar)
    return tokens.ok && tokens.tokens.some((token) => readOptionToken(spec, token) !== null)
  })
}

export type BypassFlagGroup = {
  option: string
  tokens: string[]
  /** Each token exactly as written in the flag. */
  rawTokens: string[]
  /** The group's text as written in the flag, quoting kept. */
  text: string
  /** False for a companion option that rides along with the bypass, like Devin's trust prompt switch. */
  permission: boolean
}

const flagGroupCache = new Map<TuiAgent, BypassFlagGroup[]>()

/** The agent's bypass flag split into its options, each with its value. */
export function bypassFlagGroups(agent: TuiAgent): BypassFlagGroup[] {
  let groups = flagGroupCache.get(agent)
  if (groups) {
    return groups
  }
  groups = []
  const flag = YOLO_TUI_AGENT_ARGS[agent] ?? ''
  const tokenized = tokenizeStartupCommand(flag, 'posix')
  const { options } = agentPermissionArgSpec(agent)
  for (let index = 0; tokenized.ok && index < tokenized.tokens.length; index += 1) {
    const option = tokenized.tokens[index]
    const value = tokenized.tokens[index + 1]
    const end = value !== undefined && !value.startsWith('-') ? index + 1 : index
    groups.push({
      option,
      tokens: tokenized.tokens.slice(index, end + 1),
      rawTokens: tokenized.spans
        .slice(index, end + 1)
        .map((span) => flag.slice(span.start, span.end)),
      text: flag.slice(tokenized.spans[index].start, tokenized.spans[end].end),
      permission: options.some((spec) => spec.names.includes(option))
    })
    index = end
  }
  flagGroupCache.set(agent, groups)
  return groups
}

/** The bypass flag to put before these extra arguments, without a companion option they set themselves. */
export function bypassFlagBeside(agent: TuiAgent, extra: string, shell: AgentStartupShell): string {
  return bypassFlagGroups(agent)
    .filter((group) => group.permission || !argumentsSetOption(extra, group.option, [shell]))
    .map((group) => group.text)
    .join(' ')
}

export type AgentPermissionPosture = {
  /** The mode Settings stores for this agent. */
  mode: AgentPermissionMode
  /** Whether the agent actually launches in bypass, after its own Arguments and env have their say. */
  effectiveBypass: boolean
  /** Permission settings typed into the agent's Arguments; when present they decide. */
  typedArgumentOptions: string[]
  /** Permission settings typed into the agent's environment (`NAME=value`); when present they decide. */
  typedEnvironmentOptions: string[]
}

/**
 * What an agent's permission settings add up to when launched at `target`. Settings and structured
 * sessions read it with this machine's terminal shell, each launch composer with its own target, so
 * they disagree only for text two shells split differently.
 */
export function resolveAgentPermissionPosture(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined,
  target: AgentLaunchTarget
): AgentPermissionPosture {
  const mode = resolveAgentPermissionMode(agent, settings)
  const typed = classifyTypedAgentPermissions(
    agent,
    { args: settings?.agentDefaultArgs?.[agent], env: settings?.agentDefaultEnv?.[agent] },
    resolveAgentLaunchGrammar(target)
  )
  return {
    mode,
    effectiveBypass:
      typed.kind === 'none'
        ? mode === 'bypass' && agentHasPermissionMode(agent)
        : typed.kind === 'bypass',
    typedArgumentOptions: typed.argumentOptions,
    typedEnvironmentOptions: typed.environmentOptions
  }
}
