import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { agentPickerPanelArguments } from './agent-launch-picker-arguments'
import {
  agentPickerArgumentsText,
  agentPickerEffectiveChoices,
  type AgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'
import type { AgentChoicePatch } from './agent-launch-choices'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import { patchKeys, publishAccepted } from './agent-launch-picker-receipt'
import {
  agentPickerArgumentPermission,
  editAgentPickerPermission
} from './agent-launch-picker-permission'
import { editAgentPickerSpeed, removeAgentPickerSpeed } from './agent-launch-picker-speed'
import {
  findCatalogModel,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'

export type AgentPickerEdit =
  | { kind: 'choice'; patch: AgentChoicePatch }
  | { kind: 'permission'; value: AgentPermissionChoice }
  | { kind: 'speed'; key: string; value: string; model?: string }
  | { kind: 'arguments'; text: string; model?: string }
  | { kind: 'accept-arguments' }
  | { kind: 'remove-chip'; key: string; model?: string }

/** Accept the latest complete buffer once; earlier keystrokes have no semantic receipt. */
export function acceptAgentPickerArguments(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentPickerDraft {
  if (
    draft.pendingArguments === undefined ||
    agentPickerArgumentsText(entry, draft) === undefined
  ) {
    return draft
  }
  const catalog = getAgentSessionOptionLaunchCatalog(entry.agent)
  const keys = new Set([
    'model',
    'permissionMode',
    ...(catalog?.unknownModelOptions ?? []).map((option) => option.id),
    ...(catalog?.models.flatMap((model) => model.options.map((option) => option.id)) ?? [])
  ])
  const pending = analyzeAgentChoiceArgs(entry.agent, draft.pendingArguments)
  const source = agentPickerArgumentsText(entry, draft) ?? ''
  const current = analyzeAgentChoiceArgs(entry.agent, source)
  const permission = agentPickerArgumentPermission(entry, draft)
  const pendingPermission = agentPickerArgumentPermission(entry, {
    ...draft,
    arguments: draft.pendingArguments
  })
  const selection = draft.recipeEdits?.selection
  const ownsSource = !selection || selection.source.scope === 'global' || selection.source.ownsArgs
  const pendingModel = pending.occurrences.find((item) => item.key === 'model' && item.source)
  const currentModel =
    current.occurrences.find((item) => item.key === 'model' && item.source)?.value ??
    agentPickerEffectiveChoices(entry, draft).model
  const ranges = current.occurrences.filter(
    (item) =>
      ownsSource &&
      item.key !== 'permissionMode' &&
      item.source &&
      !pending.opaqueKeys.has(item.key) &&
      (!pendingModel ||
        pendingModel.value === currentModel ||
        item.key === 'model' ||
        catalog?.unknownModelOptions?.some(
          (option) => option.id === item.key && option.apply.launchArgs
        )) &&
      (draft.arguments !== undefined ||
        draft.literalKeys?.includes(item.key) ||
        (item.key === 'model'
          ? draft.choices.model === undefined
          : draft.choices.options?.[item.key] === undefined)) &&
      !pending.occurrences.some((incoming) => incoming.key === item.key)
  )
  const prefix = [
    ...(ownsSource &&
    permission &&
    !permission.opaque &&
    !pendingPermission &&
    (!draft.choices.permissionMode || draft.literalKeys?.includes('permissionMode'))
      ? [permission.flag]
      : []),
    ...(current.cut(ranges) !== null
      ? ranges
          .filter((item) => item.replacement === undefined)
          .map((item) => source.slice(item.start, item.end))
      : [])
  ]
    .filter(Boolean)
    .join(' ')
  let original = [prefix, draft.pendingArguments].filter(Boolean).join(' ')
  const retainedKeys = new Set(ranges.map((item) => item.key))
  if (ownsSource && permission && !permission.opaque && !pendingPermission) {
    retainedKeys.add('permissionMode')
  }
  const retainedOptions = Object.fromEntries(
    ranges.filter((item) => item.replacement !== undefined).map((item) => [item.key, item.value])
  )
  if (Object.keys(retainedOptions).length) {
    original = projectAgentLaunchProfile(entry.agent, undefined, {
      target: 'terminal',
      userArgs: original,
      choices: { permissionMode: 'own', options: retainedOptions }
    }).args
  }
  const result = reconcileAgentChoiceArgsDetailed({
    agent: entry.agent,
    userArgs: original,
    choices: agentPickerEffectiveChoices(entry, draft),
    mode: 'arguments-edit',
    keys,
    retainedKeys
  })
  return publishAccepted(
    entry,
    draft,
    result,
    result.effects,
    true,
    result.userArgs || null,
    original
  )
}

/** One accepted breakdown feeds the full launch draft and the captured own-source writer. */
export function applyAgentPickerEdit(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  edit: AgentPickerEdit
): AgentPickerDraft {
  if (edit.kind === 'arguments') {
    return agentPickerArgumentsText(entry, draft) === undefined
      ? draft
      : {
          ...draft,
          pendingArguments: edit.text,
          ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {})
        }
  }
  draft = acceptAgentPickerArguments(entry, draft)
  if (edit.kind === 'accept-arguments') {
    return draft
  }
  const patch: AgentChoicePatch =
    edit.kind === 'choice'
      ? edit.patch
      : edit.kind === 'permission'
        ? { permissionMode: edit.value }
        : edit.kind === 'speed'
          ? { options: { [edit.key]: edit.value } }
          : edit.key === 'model'
            ? { model: null }
            : edit.key === 'permissionMode'
              ? { permissionMode: 'own' }
              : {
                  options: {
                    [edit.key]:
                      edit.key === 'fastMode'
                        ? 'false'
                        : edit.key === 'serviceTier'
                          ? 'default'
                          : null
                  }
                }
  const keys = new Set(patchKeys(patch))
  const source = agentPickerArgumentsText(entry, draft) ?? ''
  const visible = agentPickerPanelArguments(entry, draft)
  const catalog = getAgentSessionOptionLaunchCatalog(entry.agent)
  const model = findCatalogModel(
    catalog ?? { models: [], modelApply: {} },
    visible.choices.model ?? ''
  )
  const dependency = model?.options.some(
    (option) => keys.has(option.id) && option.apply.composedIntoModel
  )
  const result = reconcileAgentChoiceArgsDetailed({
    agent: entry.agent,
    userArgs: source,
    choices: visible.choices,
    mode: 'choice-edit',
    keys: dependency ? new Set([...keys, 'model']) : keys,
    patch,
    sourceEdit: true,
    ...(patch.permissionMode !== undefined
      ? { permissionRanges: agentPickerArgumentPermission(entry, draft)?.ranges }
      : {})
  })
  const analysis = analyzeAgentChoiceArgs(entry.agent, source)
  if ([...keys].some((key) => analysis.opaqueKeys.has(key))) {
    return draft
  }
  const domain =
    patch.permissionMode && patch.permissionMode !== 'default'
      ? editAgentPickerPermission(entry, draft, patch.permissionMode)
      : edit.kind === 'speed' ||
          (edit.kind === 'remove-chip' && (edit.key === 'fastMode' || edit.key === 'serviceTier'))
        ? (edit.kind === 'remove-chip' ? removeAgentPickerSpeed : editAgentPickerSpeed)(
            entry,
            draft,
            edit.key,
            patch.options![edit.key]!,
            visible.choices.model ?? edit.model
          )
        : undefined
  return publishAccepted(
    entry,
    draft,
    result,
    result.effects,
    false,
    domain ? domain.arguments : draft.arguments !== undefined ? result.userArgs || null : undefined
  )
}
