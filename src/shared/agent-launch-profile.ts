import type { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import { agentPermissionArgsForLaunch } from './agent-permission-args'
import type { AgentLaunchInputViews, AgentDedicatedChoices } from './agent-launch-choices'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch,
  type ResolvedSessionOptionLaunch
} from './agent-session-option-launch'
import type { AgentLaunchProfileSettings } from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { hasTypedAgentPermission, resolveAgentPermission } from './tui-agent-permission-choice'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
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
  modelContext?: string
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
  const launch = resolveAgentSessionOptionLaunch(
    agent,
    values,
    [],
    false,
    parsed.tokens,
    input.modelContext
  )
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

/** Derive both route values from one current source result; recognition alone never requests emission. */
export function projectAgentLaunchInputViews(
  agent: TuiAgent,
  choices: AgentDedicatedChoices,
  result: ReturnType<typeof reconcileAgentChoiceArgsDetailed>,
  input: {
    agentArgs?: string | null
    modelContext?: string
    sourceKeys?: readonly string[]
    permissionContext?: AgentPermissionChoice
  }
): AgentLaunchInputViews {
  const terminal = { ...choices, options: { ...choices.options } }
  const chat = { ...choices, options: { ...choices.options } }
  for (const entry of input.agentArgs !== undefined ? result.recognized : []) {
    if (input.sourceKeys === undefined || input.sourceKeys.includes(entry.key)) {
      if (entry.key === 'model') {
        chat.model = entry.value
      } else if (entry.key === 'permissionMode') {
        chat.permissionMode = result.sourceChoices.permissionMode
      } else {
        chat.options[entry.key] = entry.value
      }
    }
    if (
      entry.key === 'model' &&
      input.sourceKeys !== undefined &&
      !input.sourceKeys.includes('model') &&
      result.selected.some(
        (selected) => selected.key === 'model' && selected.owned && selected.lift
      )
    ) {
      terminal.model ??= entry.value
    }
  }
  const profile = projectAgentLaunchProfile(
    agent,
    { agentPermissionDefault: 'own' },
    {
      target: 'terminal',
      userArgs: input.agentArgs ?? '',
      choices: { permissionMode: input.permissionContext, ...terminal },
      modelContext:
        result.recognized.find((entry) => entry.key === 'model')?.value ?? input.modelContext
    }
  )
  const values = (value: AgentDedicatedChoices) => ({
    ...value.options,
    ...(value.model !== undefined ? { model: value.model } : {}),
    ...(value.permissionMode !== undefined ? { permissionMode: value.permissionMode } : {})
  })
  const sessionOptions = values(terminal)
  if (terminal.model === undefined && profile.launch.appliedValues.model !== undefined) {
    sessionOptions.model = String(profile.launch.appliedValues.model)
  }
  return {
    ...(input.agentArgs !== undefined
      ? {
          agentArgs:
            input.permissionContext !== undefined && profile.permissionArgs
              ? [profile.permissionArgs, input.agentArgs].filter(Boolean).join(' ')
              : input.agentArgs
        }
      : {}),
    ...(Object.keys(sessionOptions).length ? { sessionOptions } : {}),
    ...((input.agentArgs !== undefined && result.recognized.length) ||
    (terminal.model === undefined && profile.launch.appliedValues.model !== undefined)
      ? { chatSessionOptions: values(chat) }
      : {})
  }
}
