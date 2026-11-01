import type { AgentDedicatedChoices } from './agent-launch-choices'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import { stripLiftableAgentPermissionArgs } from './tui-agent-permission-lift'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch,
  type ResolvedSessionOptionLaunch
} from './agent-session/options/agent-session-option-launch'
import type { AgentLaunchProfileSettings } from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import {
  agentPermissionArgs,
  hasTypedAgentPermission,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { agentArgsSetPermission } from './agent-permission-args'
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
  let userArgs =
    input.userArgs ??
    settings?.agentDefaultArgs?.[agent] ??
    (typed || input.choices?.permissionMode !== undefined ? '' : (YOLO_TUI_AGENT_ARGS[agent] ?? ''))
  // Why: a permission flag saved as Arguments text by an older client must not outvote the stored
  // choice forever (#37046): permission writes keep the two in step only on newer clients, so a
  // stale Orca recipe in the stored text otherwise replays its old mode on every launch. Text a
  // caller passes for this launch stays authoritative, and an `own` choice keeps stored bytes.
  const storedChoice =
    input.userArgs === undefined && typed
      ? resolveAgentPermission(agent, settings).choice
      : undefined
  if (input.target === 'terminal' && storedChoice !== undefined && storedChoice !== 'own') {
    userArgs = stripLiftableAgentPermissionArgs(agent, userArgs)
  }
  const composePermission = (
    choice: AgentPermissionChoice,
    text: string
  ): { permission: string | null; text: string } => {
    if (choice === 'own') {
      return { permission: '', text }
    }
    if (!agentArgsSetPermission(agent, text)) {
      return { permission: agentPermissionArgs(agent, choice), text }
    }
    return { permission: null, text }
  }
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
    const { permission, text } = composePermission(choices.permissionMode, userArgs)
    return {
      args: [permission, text].filter(Boolean).join(' '),
      choices,
      launch: emptyLaunch,
      ...(permission ? { permissionArgs: permission } : {})
    }
  }
  const terminalPermission =
    input.target === 'terminal' && choices.permissionMode
      ? composePermission(choices.permissionMode, userArgs)
      : { permission: '' as string | null, text: userArgs }
  const parsed = tokenizeStartupCommand(terminalPermission.text, shell)
  if (!parsed.ok) {
    return { args: userArgs, choices, launch: emptyLaunch }
  }
  const launch = resolveAgentSessionOptionLaunch(agent, values, [], false, parsed.tokens)
  const kept = removeOverriddenAgentSessionArgs(agent, launch.appliedValues, parsed.tokens)
  const raw =
    kept.length === parsed.tokens.length &&
    kept.every((token, index) => token === parsed.tokens[index])
      ? terminalPermission.text
      : kept.map((token) => quoteStartupArg(token, shell)).join(' ')
  if (input.target === 'structured') {
    return { args: raw, choices, launch }
  }
  const render = (token: string) =>
    /^[A-Za-z0-9_./:=@-]+$/.test(token) ? token : quoteStartupArg(token, shell)
  const prefix = launch.args.map(render).join(' ')
  return {
    args: [prefix, terminalPermission.permission ?? '', raw].filter(Boolean).join(' '),
    choices,
    launch,
    ...(terminalPermission.permission ? { permissionArgs: terminalPermission.permission } : {})
  }
}
