import { agentPermissionArgsForLaunch } from './agent-permission-args'
import type { AgentDedicatedChoices } from './agent-launch-choices'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch,
  type ResolvedSessionOptionLaunch
} from './agent-session-option-launch'
import type { AgentLaunchProfileSettings } from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { hasTypedAgentPermission, resolveAgentPermission } from './tui-agent-permission-choice'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export type AgentLaunchProfileProjection = {
  target: 'terminal' | 'structured' | 'legacy-permission'
  choices?: AgentDedicatedChoices
  userArgs?: string
  shell?: AgentStartupShell
}

export function projectAgentLaunchProfile(
  agent: TuiAgent,
  settings: AgentLaunchProfileSettings | null | undefined,
  input: AgentLaunchProfileProjection
): {
  args: string
  choices: AgentDedicatedChoices
  launch: ResolvedSessionOptionLaunch
  permissionArgs?: string
} {
  const typed = hasTypedAgentPermission(settings)
  const userArgs =
    input.userArgs ??
    settings?.agentDefaultArgs?.[agent] ??
    (typed || input.choices?.permissionMode !== undefined ? '' : (YOLO_TUI_AGENT_ARGS[agent] ?? ''))
  const choices = resolveAgentChoiceLayers({
    agent,
    defaults: {
      ...settings?.agentLaunchChoices?.[agent],
      ...(typed ? { permissionMode: resolveAgentPermission(agent, settings).choice } : {})
    },
    explicit: input.choices,
    userArgs,
    argumentOwner: input.userArgs === undefined ? 'defaults' : 'launch',
    shell: input.shell
  })
  const values = {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {})
  }
  const shell = input.shell ?? 'posix'
  const emptyLaunch: ResolvedSessionOptionLaunch = { args: [], appliedValues: {} }
  if (!Object.keys(values).length) {
    if (
      input.target !== 'terminal' ||
      !choices.permissionMode ||
      choices.permissionMode === 'own'
    ) {
      return { args: userArgs, choices, launch: emptyLaunch }
    }
    if (!tokenizeStartupCommand(userArgs, shell).ok) {
      return { args: userArgs, choices, launch: emptyLaunch }
    }
    const permission = agentPermissionArgsForLaunch(agent, choices.permissionMode, userArgs)
    return {
      args: [permission, userArgs].filter(Boolean).join(' '),
      choices,
      launch: emptyLaunch,
      ...(permission ? { permissionArgs: permission } : {})
    }
  }
  const parsed = tokenizeStartupCommand(userArgs, shell)
  if (!parsed.ok) {
    return { args: userArgs, choices, launch: emptyLaunch }
  }
  const launch = resolveAgentSessionOptionLaunch(agent, values, [], false, parsed.tokens)
  const kept = removeOverriddenAgentSessionArgs(agent, launch.appliedValues, parsed.tokens)
  const raw =
    kept.length === parsed.tokens.length &&
    kept.every((token, index) => token === parsed.tokens[index])
      ? userArgs
      : kept.map((token) => quoteStartupArg(token, shell)).join(' ')
  if (input.target === 'structured') {
    return { args: raw, choices, launch }
  }
  const render = (token: string) =>
    /^[A-Za-z0-9_./:=@-]+$/.test(token) ? token : quoteStartupArg(token, shell)
  const permission =
    input.target === 'terminal' && choices.permissionMode
      ? agentPermissionArgsForLaunch(agent, choices.permissionMode, userArgs)
      : ''
  const prefix = launch.args.map(render).join(' ')
  return {
    args: [prefix, permission, raw].filter(Boolean).join(' '),
    choices,
    launch,
    ...(permission ? { permissionArgs: permission } : {})
  }
}
