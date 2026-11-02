import { analyzeAgentChoiceArgs } from './agent-choice-args'
import { agentArgsSetPermission, analyzeAgentChoiceWords } from './agent-permission-args'
import {
  agentPermissionArgs,
  agentPermissionChoices,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import {
  agentPickerArgumentsText,
  type AgentPickerDraft,
  type AgentPickerEntry
} from './agent-launch-picker'

/** Keep opaque Arguments literal; only separate spans the common analyzer can cut safely. */
export function agentPickerArgumentPermission(entry: AgentPickerEntry, draft: AgentPickerDraft) {
  const text = agentPickerArgumentsText(entry, draft)
  if (text === undefined) {
    return undefined
  }
  const parsed = tokenizeStartupCommand(text, 'posix')
  if (!parsed.ok) {
    return { flag: text, value: text, remainingArguments: text, opaque: true }
  }
  if (!agentArgsSetPermission(entry.agent, text)) {
    return undefined
  }
  const analysis = analyzeAgentChoiceArgs(entry.agent, text)
  const { roles, carrierIndices } = analyzeAgentChoiceWords(entry.agent, parsed.tokens)
  const recipe = analysis.occurrences.find((item) => item.key === 'permissionMode' && item.owned)
  const choice = agentPermissionChoices(entry.agent).find((choice) => choice === recipe?.value)
  const ranges = carrierIndices.map((index) => {
    const name = roles[index]?.slice('option:'.length)
    let end = index
    while (roles[end + 1] === `value:${name}`) {
      end++
    }
    return {
      key: 'permissionMode',
      value: '',
      start: parsed.spans[index].start,
      end: parsed.spans[end].end,
      lift: false,
      owned: false
    }
  })
  const flag = ranges.map(({ start, end }) => text.slice(start, end)).join(' ')
  const at = carrierIndices[0]
  const value =
    choice ??
    (carrierIndices.length === 1
      ? parsed.tokens[at].includes('=')
        ? parsed.tokens[at].split('=').slice(1).join('=')
        : parsed.tokens[at + 1]
      : flag) ??
    flag
  const remainingArguments = carrierIndices.some((index) => roles[index] === 'uncertain')
    ? null
    : analysis.cut(ranges)
  return {
    flag,
    value,
    choice,
    remainingArguments: remainingArguments ?? text,
    opaque: remainingArguments === null
  }
}

export function agentPickerPermissionValue(entry: AgentPickerEntry, draft: AgentPickerDraft) {
  const carrier = agentPickerArgumentPermission(entry, draft)
  if (carrier && (draft.arguments !== undefined || draft.surface === 'terminal')) {
    return carrier.value
  }
  return (
    draft.choices.permissionMode ??
    (draft.surface === 'chat' ? entry.structured : entry.terminal).permissionMode
  )
}

export function editAgentPickerPermission(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  permissionMode: AgentPermissionChoice
): AgentPickerDraft {
  const text = agentPickerArgumentsText(entry, draft)
  if (text === undefined || !entry.surfaces.includes('terminal')) {
    return { ...draft, choices: { ...draft.choices, permissionMode } }
  }
  const carrier = agentPickerArgumentPermission(entry, draft)
  return {
    ...draft,
    choices: { ...draft.choices, permissionMode },
    ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {}),
    // Opaque carriers retain the existing compiler's precedence; never fabricate a span.
    arguments: carrier?.opaque
      ? text
      : [agentPermissionArgs(entry.agent, permissionMode), carrier?.remainingArguments ?? text]
          .filter(Boolean)
          .join(' ') || null
  }
}

export function editAgentPickerPermissionArguments(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft,
  text: string
): AgentPickerDraft {
  if (agentPickerArgumentsText(entry, draft) === undefined) {
    return draft
  }
  const next = {
    ...draft,
    arguments: text || null,
    ...(entry.ownerKey ? { argumentsOwner: entry.ownerKey } : {})
  }
  const carrier = agentPickerArgumentPermission(entry, next)
  const permissionMode = carrier?.choice ?? (!carrier ? 'own' : undefined)
  const { permissionMode: _previous, ...choices } = draft.choices
  return { ...next, choices: { ...choices, ...(permissionMode ? { permissionMode } : {}) } }
}
