import { isTuiAgent } from '../catalog/tui-agent-config'
import { isAgentSessionOptions } from '../../agent-session/lifecycle/agent-session-record'
import type { TuiAgent } from '../catalog/tui-agent'
import type { AgentPermissionChoice } from '../permissions/tui-agent-permission-choice'

export type AgentModelOptionChoices = { model?: string; options?: Record<string, string> }
export type AgentDedicatedChoices = AgentModelOptionChoices & {
  permissionMode?: AgentPermissionChoice
}
export type AgentChoicePatch = {
  model?: string | null
  options?: Record<string, string | null>
  permissionMode?: AgentPermissionChoice | 'default'
}
export function terminalAgentChoices(
  agent: TuiAgent,
  choices: AgentDedicatedChoices
): AgentDedicatedChoices {
  if (agent !== 'claude' || choices.options?.effort !== 'ultracode') {
    return choices
  }
  const { effort: _chatEffort, ...options } = choices.options
  return { ...choices, options }
}

export type AgentLaunchChoices = Partial<Record<TuiAgent, AgentModelOptionChoices>>
export type AgentChoiceCliForm =
  | {
      kind: 'value'
      names: readonly string[]
      lift: 'separate-and-long-equals' | 'never'
      /** Values outside the choice's grammar stay literal arguments instead of becoming choices. */
      recognizes?: (value: string) => boolean
    }
  | { kind: 'config'; names: readonly string[]; key: string; lift: 'codex-bare-string' | 'never' }
  | { kind: 'settings'; names: readonly string[]; key: string; lift: 'merged-json' }
  | { kind: 'recipe'; words: readonly string[]; value: AgentPermissionChoice }

/** One choice flag found in free-form agent arguments. */
export type ChoiceOccurrence = {
  key: string
  value: string
  valueType?: 'string' | 'boolean'
  source?: boolean
  words: string[]
  start: number
  end: number
  lift: boolean
  owned: boolean
  replacement?: string
}

export function normalizeAgentModelOptionChoices(
  value: unknown
): AgentModelOptionChoices | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const entries = new Map<string, unknown>(Object.entries(value))
  const rawModel = entries.get('model')
  const model = typeof rawModel === 'string' ? rawModel.trim() : ''
  const options = entries.get('options') ?? {}
  if (
    !isAgentSessionOptions(options) ||
    Object.keys(options).some((key) =>
      ['', '__proto__', 'constructor', 'prototype', 'agentId', 'model', 'permissionMode'].includes(
        key
      )
    ) ||
    (model && !isAgentSessionOptions({ model }))
  ) {
    return undefined
  }
  return model || Object.keys(options).length
    ? {
        ...(model ? { model } : {}),
        ...(Object.keys(options).length ? { options } : {})
      }
    : undefined
}

export const AGENT_LAUNCH_CHOICE_KEYS: ReadonlySet<string> = new Set([
  'model',
  'effort',
  'permissionMode'
])

export function normalizeAgentLaunchChoices(value: unknown): AgentLaunchChoices {
  const choices: AgentLaunchChoices = {}
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [agent, entry] of Object.entries(value)) {
      const normalized = normalizeAgentModelOptionChoices(entry)
      if (isTuiAgent(agent) && normalized) {
        choices[agent] = normalized
      }
    }
  }
  return choices
}

export type TerminalOptionEdits = Readonly<{ effort?: null }>

export type AgentLaunchInputViews = {
  terminalOptionEdits?: TerminalOptionEdits
  agentArgs?: string | null
  sessionOptions?: Readonly<Record<string, string>>
  chatSessionOptions?: Readonly<Record<string, string>>
}

export function agentPickerSessionOptions(choices: AgentDedicatedChoices): Record<string, string> {
  return {
    ...choices.options,
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.permissionMode ? { permissionMode: choices.permissionMode } : {})
  }
}
