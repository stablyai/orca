import {
  findCatalogModel,
  type AgentSessionOptionCatalog,
  type CatalogMidSessionApply,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { NativeChatSessionOptionRecord } from './native-chat-session-option-cache'
import {
  isSessionOptionAgentPickerCommand,
  parseBuiltSessionOptionCommand
} from './native-chat-session-option-command-matching'
import { clearTrackedOption, isFlipOnlyMidSession } from './native-chat-session-option-flip'

function clearModel(record: NativeChatSessionOptionRecord): void {
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  record.model = undefined
  if (modelId) {
    delete record.valuesByModel[modelId]
  }
}

function recordCommandApply(args: {
  record: NativeChatSessionOptionRecord
  optionId: string
  midSession: CatalogMidSessionApply | undefined
  command: string
  persist: (modelId: string | null, optionId: string, value: SessionOptionValue) => void
}): boolean {
  const { record, optionId, midSession, command, persist } = args
  if (!midSession || midSession.kind === 'unsupported') {
    return false
  }
  if (isFlipOnlyMidSession(midSession) && command === midSession.command) {
    const modelId = typeof record.model?.value === 'string' ? record.model.value : null
    clearTrackedOption(record, modelId, optionId)
    return true
  }
  if (isSessionOptionAgentPickerCommand(midSession, command)) {
    clearModel(record)
    return true
  }
  if (midSession.kind !== 'command') {
    return false
  }
  const value = parseBuiltSessionOptionCommand(midSession.build, command)
  if (!value) {
    return false
  }
  const previousModelId = typeof record.model?.value === 'string' ? record.model.value : null
  if (optionId === 'model') {
    if (previousModelId !== value) {
      // Why: a model command can reset model-scoped state, so an older value
      // from a prior visit is no longer evidence about this live session.
      delete record.valuesByModel[value]
    }
    record.model = { value, source: 'dispatched' }
    persist(value, optionId, value)
    return true
  }
  if (!previousModelId) {
    return true
  }
  record.valuesByModel[previousModelId] = {
    ...record.valuesByModel[previousModelId],
    [optionId]: { value, source: 'dispatched' }
  }
  persist(previousModelId, optionId, value)
  return true
}

export function recordNativeChatSessionOptionCommand(args: {
  catalog: AgentSessionOptionCatalog
  models: CatalogModel[]
  record: NativeChatSessionOptionRecord
  command: string
  persist: (modelId: string | null, optionId: string, value: SessionOptionValue) => void
}): { changed: boolean; opensAgentPicker: boolean } {
  const { catalog, models, record, persist } = args
  const command = args.command.trim()
  let opensAgentPicker = isSessionOptionAgentPickerCommand(catalog.modelApply.midSession, command)
  let changed = recordCommandApply({
    record,
    optionId: 'model',
    midSession: catalog.modelApply.midSession,
    command,
    persist
  })
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  const model = modelId ? findCatalogModel({ ...catalog, models }, modelId) : undefined
  for (const option of model?.options ?? []) {
    opensAgentPicker =
      opensAgentPicker || isSessionOptionAgentPickerCommand(option.apply.midSession, command)
    changed =
      recordCommandApply({
        record,
        optionId: option.id,
        midSession: option.apply.midSession,
        command,
        persist
      }) || changed
  }
  return { changed, opensAgentPicker }
}
