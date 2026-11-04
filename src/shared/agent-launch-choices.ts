import { isAgentSessionOptions } from './agent-session-record'
import type { TuiAgent } from './tui-agent'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'

export type AgentModelOptionChoices = { model?: string; options?: Record<string, string> }
export type AgentDedicatedChoices = AgentModelOptionChoices & {
  permissionMode?: AgentPermissionChoice
}
export type AgentChoicePatch = {
  model?: string | null
  options?: Record<string, string | null>
  permissionMode?: AgentPermissionChoice | 'default'
}
export type AgentLaunchChoices = Partial<Record<TuiAgent, AgentModelOptionChoices>>
export type AgentChoiceCliForm =
  | { kind: 'value'; names: readonly string[]; lift: 'separate-and-long-equals' | 'never' }
  | { kind: 'config'; names: readonly string[]; key: string; lift: 'codex-bare-string' | 'never' }
  | { kind: 'recipe'; words: readonly string[]; value: AgentPermissionChoice }

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
