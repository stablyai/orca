import type {
  AgentSessionOptionCatalog,
  CatalogMidSessionApply,
  CatalogModel,
  CatalogOptionApply
} from './agent-session-option-catalog'
import type { SessionOptionValue } from './native-chat-session-options'
import {
  clearNativeChatSessionModel,
  clearTrackedSessionOption,
  flattenNativeChatSessionOptionRecord,
  isFlipOnlyMidSession,
  matchNativeChatCatalogModelId,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'

export function parseBuiltSessionOptionCommand(
  build: (value: SessionOptionValue) => string,
  command: string
): string | null {
  const marker = '__orca_session_option_value__'
  const template = build(marker)
  const markerIndex = template.indexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  const prefix = template.slice(0, markerIndex)
  const suffix = template.slice(markerIndex + marker.length)
  if (!command.startsWith(prefix) || !command.endsWith(suffix)) {
    return null
  }
  const value = command.slice(prefix.length, command.length - suffix.length).trim()
  return value || null
}

export function isSessionOptionAgentPickerCommand(
  midSession: CatalogMidSessionApply | undefined,
  command: string
): boolean {
  return (
    (midSession?.kind === 'agent-picker' && command === midSession.command) ||
    (midSession?.kind === 'command' && command === midSession.pickerCommand)
  )
}

export function buildNativeChatSessionOptionCommand(args: {
  optionId: string
  value: SessionOptionValue
  apply: CatalogOptionApply
  modelId: string | null
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
}): string | null {
  const midSession = args.apply.midSession
  if (midSession?.kind === 'command') {
    return midSession.build(args.value)
  }
  if (midSession?.kind === 'toggle-command') {
    return midSession.command
  }
  if (!args.apply.composedIntoModel || !args.modelId || !args.catalog.composeModelValue) {
    return null
  }
  const model = args.models.find((candidate) => candidate.id === args.modelId)
  const values = flattenNativeChatSessionOptionRecord(args.record, args.modelId)
  for (const option of model?.options ?? []) {
    values[option.id] ??= option.kind.defaultValue
  }
  values[args.optionId] = args.value
  const composed = args.catalog.composeModelValue(args.modelId, values)
  return args.catalog.modelApply.midSession?.kind === 'command'
    ? args.catalog.modelApply.midSession.build(composed)
    : null
}

type PersistSessionOption = (
  modelId: string | null,
  optionId: string,
  value: SessionOptionValue
) => void

function recordCommandApply(args: {
  record: NativeChatSessionOptionRecord
  optionId: string
  midSession: CatalogMidSessionApply | undefined
  command: string
  /** Canonicalize a parsed value, or reject it. A template's prefix also matches
   *  prose that merely starts with it (`/model` parses `is a weird word` out of
   *  "/model is a weird word"), and tracking that renders raw prose as the
   *  current value — and, for the model, drops every option the model owns. */
  canonicalize: (value: string) => string | null
  /** The model the picker draws this option under. Reading the tracked model alone
   *  would drop a typed `/effort low` under a CLI default, and treat a typed
   *  `/model <that default>` as a switch that resets the model's tracked state. */
  effectiveModelId: string | null
  persist?: PersistSessionOption
}): boolean {
  const { record, optionId, midSession, command, canonicalize, effectiveModelId, persist } = args
  if (!midSession || midSession.kind === 'unsupported') {
    return false
  }
  if (isFlipOnlyMidSession(midSession) && command === midSession.command) {
    clearTrackedSessionOption(record, effectiveModelId, optionId)
    return true
  }
  if (isSessionOptionAgentPickerCommand(midSession, command)) {
    clearNativeChatSessionModel(record)
    return true
  }
  if (midSession.kind !== 'command') {
    return false
  }
  const parsed = parseBuiltSessionOptionCommand(midSession.build, command)
  if (!parsed) {
    return false
  }
  const value = canonicalize(parsed)
  if (!value) {
    return false
  }
  const previousModelId = effectiveModelId
  if (optionId === 'model') {
    if (previousModelId !== value) {
      // Why: a model command can reset model-scoped state, so an older value
      // from a prior visit is no longer evidence about this live session.
      delete record.valuesByModel[value]
    }
    record.model = { value, source: 'dispatched' }
    persist?.(value, optionId, value)
    return true
  }
  if (!previousModelId) {
    return true
  }
  record.valuesByModel[previousModelId] = {
    ...record.valuesByModel[previousModelId],
    [optionId]: { value, source: 'dispatched' }
  }
  persist?.(previousModelId, optionId, value)
  return true
}

export function recordNativeChatSessionOptionCommand(args: {
  catalog: AgentSessionOptionCatalog
  models: readonly CatalogModel[]
  record: NativeChatSessionOptionRecord
  command: string
  persist?: PersistSessionOption
}): { changed: boolean; opensAgentPicker: boolean } {
  const { catalog, models, record, persist } = args
  const command = args.command.trim()
  let opensAgentPicker = isSessionOptionAgentPickerCommand(catalog.modelApply.midSession, command)
  let changed = recordCommandApply({
    record,
    optionId: 'model',
    midSession: catalog.modelApply.midSession,
    command,
    // A typed model can be an alias or a full provider id, so reuse the same
    // matcher the hook reports go through rather than demanding a catalog id.
    // Whitespace means this was never a bare command — a multi-line paste whose
    // first line happens to read `/model sonnet` is a prompt as far as we can
    // tell, so track nothing rather than guess. Model ids never contain spaces.
    canonicalize: (value) =>
      /\s/.test(value)
        ? null
        : // Fall back to the seed: an alias this host's CLI no longer lists is
          // still a legitimate thing to type, and callers reconcile it back into
          // the list (withTrackedNativeChatModel) rather than blanking the row.
          (matchNativeChatCatalogModelId({ ...catalog, models: [...models] }, value) ??
          matchNativeChatCatalogModelId(catalog, value)),
    effectiveModelId: resolveEffectiveNativeChatModelId(catalog, models, record),
    persist
  })
  // Re-resolved: the command above may have just tracked a model.
  const modelId = resolveEffectiveNativeChatModelId(catalog, models, record)
  const model = modelId ? models.find((candidate) => candidate.id === modelId) : undefined
  for (const option of model?.options ?? []) {
    opensAgentPicker =
      opensAgentPicker || isSessionOptionAgentPickerCommand(option.apply.midSession, command)
    changed =
      recordCommandApply({
        record,
        optionId: option.id,
        midSession: option.apply.midSession,
        command,
        canonicalize: (value) =>
          option.kind.type === 'select' &&
          !option.kind.choices.some((choice) => choice.value === value)
            ? null
            : value,
        effectiveModelId: modelId,
        persist
      }) || changed
  }
  return { changed, opensAgentPicker }
}
