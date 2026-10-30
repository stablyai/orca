import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { reconcileAgentChoiceArgs } from './agent-choice-reconciliation'
import { projectAgentLaunchProfile } from './agent-launch-profile'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import { agentPermissionArgs } from './tui-agent-permission-choice'
import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import { agentPickerArgumentPermission } from './agent-launch-picker-permission'
import {
  agentPickerArgumentsText,
  type AgentPickerEntry,
  type AgentPickerDraft
} from './agent-launch-picker'
const textOf = agentPickerArgumentsText
export function cutAgentPickerComposedSpeed(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  source: string,
  key: string,
  value: string,
  model?: string
) {
  const terminal = {
    ...entry.terminal,
    ...draft.choices,
    model:
      draft.choices.model ??
      entry.terminal.model ??
      (draft.surface === 'terminal' ? model : undefined),
    options: { ...entry.terminal.options, ...draft.choices.options }
  }
  return reconcileAgentChoiceArgs({
    agent: entry.agent,
    userArgs: source,
    choices: terminal,
    mode: 'choice-edit',
    keys: new Set([key, 'model']),
    patch: { options: { [key]: value } }
  }).userArgs
}

function speedText(entry: AgentPickerEntry, draft: AgentPickerDraft): string {
  const permission = agentPickerArgumentPermission(entry, draft)
  return permission && !permission.opaque
    ? permission.remainingArguments
    : (textOf(entry, draft) ?? '')
}

export function agentPickerSpeedIsOpaque(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  key: string
) {
  return analyzeAgentChoiceArgs(entry.agent, speedText(entry, draft)).opaqueKeys.has(key)
}

export function agentPickerSpeedValue(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  key: string
) {
  const analysis = analyzeAgentChoiceArgs(entry.agent, speedText(entry, draft))
  if (analysis.opaqueKeys.has(key)) {
    return undefined
  }
  const raw = analysis.occurrences.filter((item) => item.key === key)
  if (
    (draft.surface === 'terminal' || draft.arguments !== undefined) &&
    raw.length &&
    analysis.cut(raw) !== null
  ) {
    return raw.at(-1)?.value
  }
  return (
    draft.choices.options?.[key] ??
    (draft.surface === 'chat' ? entry.structured : entry.terminal).options?.[key]
  )
}

export function agentPickerSpeedFlag(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  key: string,
  value: string,
  model?: string
) {
  const option =
    agentPickerEntryOptions(entry, model, 'terminal').find((option) => option.id === key) ??
    getAgentSessionOptionLaunchCatalog(entry.agent)?.unknownModelOptions?.find(
      (option) => option.id === key
    )
  if (!option?.apply.launchArgs && !option?.apply.composedIntoModel) {
    return ''
  }
  return projectAgentLaunchProfile(entry.agent, undefined, {
    target: 'terminal',
    userArgs: '',
    choices: {
      permissionMode: 'own',
      ...(option.apply.composedIntoModel
        ? {
            model:
              draft.choices.model ??
              entry.terminal.model ??
              (draft.surface === 'terminal' ? model : undefined)
          }
        : {}),
      options: option.apply.composedIntoModel
        ? {
            ...entry.terminal.options,
            ...draft.choices.options,
            [key]: value
          }
        : { [key]: value }
    }
  }).args
}

export function editAgentPickerSpeed(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  key: string,
  value: string,
  model?: string
): AgentPickerDraft {
  if (textOf(entry, draft) === undefined || !entry.surfaces.includes('terminal')) {
    return {
      ...draft,
      choices: { ...draft.choices, options: { ...draft.choices.options, [key]: value } }
    }
  }
  if (agentPickerSpeedIsOpaque(entry, draft, key)) {
    return draft
  }
  const permission = agentPickerArgumentPermission(entry, draft)
  const permissionPrefix = permission
    ? permission.opaque
      ? ''
      : permission.flag
    : agentPermissionArgs(entry.agent, entry.terminal.permissionMode ?? 'own')
  const source =
    permission && !permission.opaque ? permission.remainingArguments : (textOf(entry, draft) ?? '')
  if (entry.agent === 'claude' && key === 'fastMode') {
    const projected = projectAgentLaunchProfile(entry.agent, undefined, {
      target: 'terminal',
      userArgs: source,
      choices: { permissionMode: 'own', options: { [key]: value } }
    })
    return {
      ...draft,
      choices: { ...draft.choices, options: { ...draft.choices.options, [key]: value } },
      arguments: [permissionPrefix, projected.args].filter(Boolean).join(' ') || null,
      ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {})
    }
  }
  const analysis = analyzeAgentChoiceArgs(entry.agent, source)
  const selected = analysis.occurrences.filter((item) => item.key === key)
  let remaining = analysis.cut(selected) ?? source
  const option = agentPickerEntryOptions(entry, model, 'terminal').find(
    (option) => option.id === key
  )
  if (option?.apply.composedIntoModel) {
    remaining = cutAgentPickerComposedSpeed(entry, draft, source, key, value, model)
  }
  const flag = agentPickerSpeedFlag(entry, draft, key, value, model)
  return {
    ...draft,
    choices: { ...draft.choices, options: { ...draft.choices.options, [key]: value } },
    ...(flag
      ? {
          arguments: [permissionPrefix, flag, remaining].filter(Boolean).join(' '),
          ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {})
        }
      : {})
  }
}
