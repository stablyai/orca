import { clearTerminalEffortArgs } from './terminal-effort-option-edit'
import type { TerminalOptionEdits } from '../choices/agent-launch-choices'
import { resolveAgentChoiceLayers, yieldAgentChoicesToArgs } from '../choices/agent-choice-layers'
import {
  resolveTuiAgentLaunchRawArgs,
  type AgentLaunchProfileSettings
} from '../choices/tui-agent-launch-defaults'
import { readLaunchPermissionChoice } from '../permissions/tui-agent-permission-choice'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import {
  hasExtraAgentArgs,
  parseExtraAgentArgs,
  mergeParsedExtraAgentArgs
} from './automation-extra-agent-args'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from '../catalog/tui-agent'

/** Resolve authored defaults against the original raw text before compiling either into argv. */
export function terminalSessionOptionInputs(args: {
  agent: TuiAgent
  settings?: AgentLaunchProfileSettings | null
  terminalOptionEdits?: TerminalOptionEdits
  sessionOptions: Readonly<Record<string, SessionOptionValue>> | undefined
  yieldToAgentArgs?: boolean
  agentArgs: string | null | undefined
  shell: AgentStartupShell
  command?: string
  extraAgentArgs?: string
}): {
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: true
} {
  const permission = readLaunchPermissionChoice(args.sessionOptions)
  let raw =
    args.agentArgs === undefined
      ? resolveTuiAgentLaunchRawArgs(
          args.agent,
          args.settings,
          permission ? 'own' : undefined,
          args.shell
        )
      : args.agentArgs
  const extras = hasExtraAgentArgs(args.extraAgentArgs)
    ? parseExtraAgentArgs({ agent: args.agent, extraAgentArgs: args.extraAgentArgs })
    : undefined
  if (extras && !extras.ok) {
    throw new Error(extras.error)
  }
  if (extras?.ok) {
    const merged = mergeParsedExtraAgentArgs({
      agent: args.agent,
      defaultArgs: raw,
      extras,
      shell: args.shell
    })
    if (!merged.ok) {
      throw new Error(merged.error)
    }
    raw = merged.agentArgs
  }
  const clearsEffort = args.terminalOptionEdits?.effort === null
  if (clearsEffort && raw) {
    raw = clearTerminalEffortArgs(args.agent, raw)
  }
  const authored = args.settings?.agentLaunchChoices?.[args.agent]
  let defaultValues: Record<string, string> = {
    ...authored?.options,
    ...(authored?.model ? { model: authored.model } : {})
  }
  if (clearsEffort) {
    delete defaultValues.effort
  }
  if (Object.keys(defaultValues).length) {
    const command = tokenizeStartupCommand(args.command ?? '', args.shell)
    defaultValues = yieldAgentChoicesToArgs(args.agent, defaultValues, [
      ...(command.ok ? command.tokens : []),
      ...(extras?.ok ? extras.tokens : [])
    ])
  }
  const { model: defaultModel, ...defaultOptions } = defaultValues
  const choices = resolveAgentChoiceLayers({
    agent: args.agent,
    defaults: { ...(defaultModel ? { model: defaultModel } : {}), options: defaultOptions },
    action: args.sessionOptions
      ? {
          ...(typeof args.sessionOptions.model === 'string'
            ? { model: args.sessionOptions.model }
            : {}),
          options: Object.fromEntries(
            Object.entries(args.sessionOptions)
              .filter(
                ([id]) =>
                  !['model', 'mode', 'permissionMode'].includes(id) &&
                  !(clearsEffort && id === 'effort')
              )
              .map(([id, value]) => [id, String(value)])
          ),
          ...(permission ? { permissionMode: permission } : {})
        }
      : undefined,
    argumentOwner: args.agentArgs === undefined ? 'defaults' : 'launch',
    userArgs: raw,
    launchPreferencesYieldToAgentArgs: args.yieldToAgentArgs,
    shell: args.shell
  })
  const sessionOptions = {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
  return {
    agentArgs: raw,
    ...(Object.keys(sessionOptions).length > 0
      ? { sessionOptions, sessionOptionsOverrideAgentArgs: true as const }
      : {})
  }
}
