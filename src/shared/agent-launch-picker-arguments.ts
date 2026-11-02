import { agentArgsSetPermission } from './agent-permission-args'
import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { agentPermissionChoices } from './tui-agent-permission-choice'
import {
  agentPickerSpeedValue,
  agentPickerSpeedFlag,
  agentPickerSpeedIsOpaque,
  editAgentPickerSpeed,
  cutAgentPickerComposedSpeed
} from './agent-launch-picker-speed'
export { agentPickerSpeedValue, editAgentPickerSpeed } from './agent-launch-picker-speed'
import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import {
  agentPickerArgumentPermission,
  agentPickerPermissionValue,
  editAgentPickerPermission,
  editAgentPickerPermissionArguments
} from './agent-launch-picker-permission'
import {
  agentPickerArgumentsText,
  type AgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'

const speedKeys = new Set(['fastMode', 'serviceTier'])
const textOf = (entry: AgentPickerEntry, draft: AgentPickerDraft) =>
  agentPickerArgumentsText(entry, draft)

/** Only permission and speed carriers are shared by the panel; raw model/effort remain terminal-owned. */
export function editAgentPickerPanelArguments(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  text: string
): AgentPickerDraft {
  if (textOf(entry, draft) === undefined) {
    return draft
  }
  const next = editAgentPickerPermissionArguments(entry, draft, text)
  const analysis = analyzeAgentChoiceArgs(
    entry.agent,
    agentPickerArgumentPermission(entry, next)?.remainingArguments ?? text
  )
  const previous = analyzeAgentChoiceArgs(
    entry.agent,
    agentPickerArgumentPermission(entry, draft)?.remainingArguments ?? textOf(entry, draft) ?? ''
  )
  for (const key of speedKeys) {
    const raw = analysis.occurrences.filter((item) => item.key === key)
    const value =
      raw.length && analysis.cut(raw) !== null
        ? raw.at(-1)?.value
        : !raw.length && previous.occurrences.some((item) => item.key === key)
          ? key === 'fastMode'
            ? 'false'
            : 'default'
          : undefined
    if (analysis.opaqueKeys.has(key)) {
      const options = { ...next.choices.options }
      delete options[key]
      next.choices = { ...next.choices, options }
    } else if (value !== undefined) {
      next.choices = { ...next.choices, options: { ...next.choices.options, [key]: value } }
    }
  }
  return next
}

export function agentPickerPanelArguments(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  model?: string
) {
  let text = textOf(entry, draft) ?? ''
  const value = agentPickerPermissionValue(entry, draft)
  const rawPermission = agentPickerArgumentPermission(entry, draft)
  const permission =
    rawPermission && (draft.arguments !== undefined || draft.surface === 'terminal')
      ? rawPermission.choice
      : agentPermissionChoices(entry.agent).find((choice) => choice === value)
  const resolved =
    permission && textOf(entry, draft) !== undefined
      ? editAgentPickerPermission(entry, draft, permission)
      : draft
  text = textOf(entry, resolved) ?? ''
  const carrier = agentPickerArgumentPermission(entry, { ...resolved, arguments: text || null })
  const chips: { key: string; flag: string; remove: () => AgentPickerDraft }[] = []
  if (carrier && !carrier.opaque) {
    text = carrier.remainingArguments
    chips.push({
      key: 'permissionMode',
      flag: carrier.flag,
      remove: () =>
        editAgentPickerPermission(
          entry,
          { ...resolved, arguments: textOf(entry, resolved) || null },
          'own'
        )
    })
  }
  for (const key of speedKeys) {
    if (agentPickerSpeedIsOpaque(entry, draft, key)) {
      continue
    }
    const analysis = analyzeAgentChoiceArgs(entry.agent, text)
    const raw = analysis.occurrences.filter((item) => item.key === key)
    let remaining = analysis.cut(raw)
    const selected = agentPickerSpeedValue(entry, draft, key)
    const option = agentPickerEntryOptions(entry, model, 'terminal').find(
      (option) => option.id === key
    )
    if (option?.apply.composedIntoModel && selected !== undefined) {
      remaining = cutAgentPickerComposedSpeed(entry, draft, text, key, selected, model)
    }
    const flag =
      raw.length && remaining !== null
        ? raw.some((item) => item.replacement !== undefined)
          ? agentPickerSpeedFlag(entry, draft, key, raw.at(-1)!.value, model)
          : raw.map((item) => text.slice(item.start, item.end)).join(' ')
        : textOf(entry, draft) !== undefined &&
            selected !== undefined &&
            selected !== 'false' &&
            selected !== 'default'
          ? agentPickerSpeedFlag(entry, draft, key, selected, model)
          : ''
    if (!flag || remaining === null) {
      continue
    }
    text = remaining
    chips.push({
      key,
      flag,
      remove: () => {
        const next = editAgentPickerSpeed(
          entry,
          { ...draft, arguments: textOf(entry, resolved) || null },
          key,
          key === 'fastMode' ? 'false' : 'default',
          model
        )
        const permission = agentPickerArgumentPermission(entry, next)
        const prefix = permission && !permission.opaque ? permission.flag : ''
        const source = prefix ? permission!.remainingArguments : (textOf(entry, next) ?? '')
        const analysis = analyzeAgentChoiceArgs(entry.agent, source)
        const raw = analysis.occurrences.filter((item) => item.key === key)
        const remaining = analysis.cut(raw)
        return remaining === null
          ? next
          : { ...next, arguments: [prefix, remaining].filter(Boolean).join(' ') || null }
      }
    })
  }
  return { text, chips, permission: value, selectedPermission: permission }
}

export function editAgentPickerPanelText(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  text: string,
  model?: string
): AgentPickerDraft {
  if (textOf(entry, draft) === undefined) {
    return draft
  }
  const view = agentPickerPanelArguments(entry, draft, model)
  const analysis = analyzeAgentChoiceArgs(entry.agent, text)
  const composedKeys = new Set(
    agentPickerEntryOptions(entry, model, 'terminal')
      .filter((option) => option.apply.composedIntoModel)
      .map((option) => option.id)
  )
  const flags = view.chips.filter(
    (chip) =>
      !(entry.agent === 'claude' && chip.key === 'fastMode') &&
      (chip.key === 'permissionMode'
        ? !agentArgsSetPermission(entry.agent, text)
        : !analysis.occurrences.some(
            (item) => item.key === chip.key || (item.key === 'model' && composedKeys.has(chip.key))
          ))
  )
  const next = editAgentPickerPanelArguments(
    entry,
    draft,
    [...flags.map((chip) => chip.flag), text].filter(Boolean).join(' ')
  )
  const speed = view.chips.find((chip) => chip.key === 'fastMode')
  const explicit = analysis.occurrences.some((item) => item.key === 'fastMode')
  const value = agentPickerSpeedValue(entry, draft, 'fastMode')
  return entry.agent === 'claude' && speed && !explicit && value !== undefined
    ? editAgentPickerSpeed(entry, next, 'fastMode', value, model)
    : next
}
