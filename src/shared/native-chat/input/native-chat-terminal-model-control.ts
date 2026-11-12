import { getAgentSessionOptionCatalog } from '../../agent-session/options/agent-session-option-catalog'
import type { AgentType } from '../../agent-status/contracts/agent-status-types'
import type { SessionOptionValue } from './native-chat-session-options'
import { buildNativeChatSessionOptionCommand } from './native-chat-session-option-commands'
import type { NativeChatSessionOptionDispatchResult } from './native-chat-session-option-dispatch'

export type TerminalModelControlIntent =
  | {
      kind: 'set'
      optionId: string
      value: SessionOptionValue
      modelId?: string
      values?: Record<string, SessionOptionValue>
    }
  | { kind: 'picker'; optionId: string }
  | { kind: 'toggle'; optionId: string; modelId?: string }

export type TerminalModelControl = {
  agent: AgentType
  intent: TerminalModelControlIntent
  observation?: {
    detectAgentInteraction?: 'claude-model-switch-confirmation'
    expectedChoiceLabel?: string
  }
}

export type TerminalModelControlResult =
  | NativeChatSessionOptionDispatchResult
  | { outcome: 'legacy' }

export function readTerminalModelControlResult(value: unknown): TerminalModelControlResult {
  if (value && typeof value === 'object' && 'outcome' in value) {
    if (
      value.outcome === 'blocked' &&
      'agent' in value &&
      typeof value.agent === 'string' &&
      'reason' in value &&
      (value.reason === 'foreign-draft' ||
        value.reason === 'target-unavailable' ||
        value.reason === 'unsupported-control' ||
        value.reason === 'admission')
    ) {
      return { outcome: 'blocked', agent: value.agent, reason: value.reason }
    }
    if (
      value.outcome === 'legacy' ||
      value.outcome === 'dispatched' ||
      value.outcome === 'picker-opened' ||
      value.outcome === 'applied' ||
      value.outcome === 'rejected' ||
      value.outcome === 'unknown'
    ) {
      return { outcome: value.outcome }
    }
  }
  return { outcome: 'unknown' }
}

/** Resolve an existing catalog action without turning model discovery into input admission. */
export function buildTerminalModelControl(
  control: TerminalModelControl
): { command: string; picker: boolean } | null {
  const catalog = getAgentSessionOptionCatalog(control.agent)
  if (!catalog) {
    return null
  }
  const intent = control.intent
  const modelId = 'modelId' in intent ? (intent.modelId ?? null) : null
  const model = catalog.models.find((candidate) => candidate.id === modelId)
  const option =
    model?.options.find((candidate) => candidate.id === intent.optionId) ??
    catalog.unknownModelOptions?.find((candidate) => candidate.id === intent.optionId) ??
    catalog.models
      .find((candidate) => candidate.isDefault)
      ?.options.find((candidate) => candidate.id === intent.optionId)
  const apply = intent.optionId === 'model' ? catalog.modelApply : option?.apply
  if (!apply) {
    return null
  }
  if (intent.kind === 'picker') {
    const mid = apply.midSession
    const command =
      mid?.kind === 'agent-picker'
        ? mid.command
        : mid?.kind === 'command'
          ? mid.pickerCommand
          : undefined
    return command ? { command, picker: true } : null
  }
  if (intent.kind === 'toggle') {
    return apply.midSession?.kind === 'toggle-command'
      ? { command: apply.midSession.command, picker: false }
      : null
  }
  const values = Object.fromEntries(
    Object.entries(intent.values ?? {}).map(([id, value]) => [
      id,
      { value, source: 'dispatched' as const }
    ])
  )
  const command = buildNativeChatSessionOptionCommand({
    optionId: intent.optionId,
    value: intent.value,
    apply,
    modelId,
    catalog,
    models: catalog.models,
    record: { agent: control.agent, valuesByModel: modelId ? { [modelId]: values } : {} }
  })
  return command ? { command, picker: false } : null
}
