import {
  isDefaultServiceTier,
  type SessionOptionDescriptor,
  type SessionOptionDisabledReason,
  type SessionOptionSelectChoice
} from './native-chat/input/native-chat-session-options'

// English pieces for the session option pickers; desktop translates each one, mobile shows them as is.
export const NATIVE_CHAT_SESSION_OPTION_COPY = {
  model: 'Model',
  effort: 'Effort',
  fastMode: 'Fast mode',
  speed: 'Speed',
  thinking: 'Thinking',
  standard: 'Standard',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
  minimalShort: 'Min',
  mediumShort: 'Med',
  xhighShort: 'XHigh',
  fast: 'Fast',
  toggleOption: 'Toggle {{value0}}',
  chooseInAgentPicker: 'Choose in agent picker…',
  setWhenSessionStarts: 'Set when the session starts.',
  availableAfterSessionStarts: 'Available after the session starts.',
  futureOptionsRequireUpdate:
    'Update Orca on this host to change future-turn choices while the agent works.',
  sessionOptions: 'Session options'
} as const

export type NativeChatSessionOptionCopyId = keyof typeof NATIVE_CHAT_SESSION_OPTION_COPY

export type NativeChatSessionOptionSay = (
  id: NativeChatSessionOptionCopyId,
  values?: { value0: string }
) => string

export const sayNativeChatSessionOptionEnglish: NativeChatSessionOptionSay = (id, values) =>
  values === undefined
    ? NATIVE_CHAT_SESSION_OPTION_COPY[id]
    : NATIVE_CHAT_SESSION_OPTION_COPY[id].replaceAll('{{value0}}', () => values.value0)

const LEVEL_IDS = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra'
} as const satisfies Record<string, NativeChatSessionOptionCopyId>

const SHORT_LEVEL_IDS = {
  minimal: 'minimalShort',
  medium: 'mediumShort',
  xhigh: 'xhighShort'
} as const satisfies Record<string, NativeChatSessionOptionCopyId>

function levelId(
  ids: Readonly<Record<string, NativeChatSessionOptionCopyId>>,
  value: string
): NativeChatSessionOptionCopyId | undefined {
  return Object.hasOwn(ids, value) ? ids[value] : undefined
}

/** The selected choice, named by its raw value when the list no longer offers it. */
export function selectedNativeChatChoice(
  descriptor: SessionOptionDescriptor
): SessionOptionSelectChoice | null {
  if (descriptor.kind.type !== 'select' || !descriptor.kind.currentValue) {
    return null
  }
  const current = descriptor.kind.currentValue
  return (
    descriptor.kind.choices.find((choice) => choice.value === current) ?? {
      value: current,
      label: current
    }
  )
}

export function nativeChatSessionOptionLabel(
  descriptor: SessionOptionDescriptor,
  say: NativeChatSessionOptionSay
): string {
  switch (descriptor.id) {
    case 'model':
      return say('model')
    case 'effort':
      return say('effort')
    case 'fastMode':
      return say('fastMode')
    case 'serviceTier':
      return say('speed')
    case 'thinking':
      return say('thinking')
    default:
      return descriptor.label
  }
}

export function nativeChatSessionChoiceLabel(
  choice: SessionOptionSelectChoice,
  say: NativeChatSessionOptionSay,
  optionId?: string
): string {
  // `default` is only Standard inside a speed choice; other selects may use the value.
  if (optionId === 'serviceTier' && choice.value === 'default') {
    return say('standard')
  }
  const id = levelId(LEVEL_IDS, choice.value)
  return id ? say(id) : choice.label
}

export function nativeChatSessionChoiceShortLabel(
  choice: SessionOptionSelectChoice,
  say: NativeChatSessionOptionSay,
  optionId?: string
): string {
  const id = levelId(SHORT_LEVEL_IDS, choice.value)
  return id ? say(id) : nativeChatSessionChoiceLabel(choice, say, optionId)
}

export function nativeChatSessionOptionActionLabel(
  descriptor: SessionOptionDescriptor,
  say: NativeChatSessionOptionSay
): string {
  // Why: flip-only without a baseline is an action — never claim On/Off.
  return descriptor.action?.type === 'toggle-command'
    ? say('toggleOption', {
        value0: nativeChatSessionOptionLabel(descriptor, say).toLowerCase()
      })
    : say('chooseInAgentPicker')
}

export function nativeChatSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined,
  say: NativeChatSessionOptionSay
): string | null {
  switch (reason) {
    case 'set-when-session-starts':
      return say('setWhenSessionStarts')
    case 'available-after-session-start':
      return say('availableAfterSessionStarts')
    case 'host-update-required':
      return say('futureOptionsRequireUpdate')
    case undefined:
      return null
  }
}

export function nativeChatModelPillLabel(
  descriptor: SessionOptionDescriptor,
  say: NativeChatSessionOptionSay
): string {
  // The tooltip names the category; default sources still identify a model, while unknown sources do not.
  const choice = descriptor.valueSource === 'unknown' ? null : selectedNativeChatChoice(descriptor)
  return choice ? nativeChatSessionChoiceLabel(choice, say) : say('model')
}

export function nativeChatOptionsPillTitle(
  descriptors: readonly SessionOptionDescriptor[],
  say: NativeChatSessionOptionSay
): string {
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  // Why: an effort-backed group is primarily the effort picker, even when it also reports modes.
  return effort ? nativeChatSessionOptionLabel(effort, say) : say('sessionOptions')
}

/** Join displayable option values after the model, e.g. High · Fast. */
export function nativeChatOptionValuesLabel(
  descriptors: readonly SessionOptionDescriptor[],
  say: NativeChatSessionOptionSay
): string {
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown' || isDefaultServiceTier(descriptor)) {
      continue
    }
    const choice = selectedNativeChatChoice(descriptor)
    if (choice) {
      labels.push(
        (descriptor.id === 'effort'
          ? nativeChatSessionChoiceShortLabel
          : nativeChatSessionChoiceLabel)(choice, say, descriptor.id)
      )
    } else if (descriptor.kind.type === 'boolean' && descriptor.kind.currentValue === true) {
      labels.push(
        descriptor.id === 'fastMode' ? say('fast') : nativeChatSessionOptionLabel(descriptor, say)
      )
    }
  }
  return labels.join(' · ')
}
