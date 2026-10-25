import {
  isDefaultServiceTier,
  type SessionOptionDescriptor,
  type SessionOptionDisabledReason,
  type SessionOptionSelectChoice
} from '../../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'

export function nativeChatSessionOptionLabel(descriptor: SessionOptionDescriptor): string {
  switch (descriptor.id) {
    case 'model':
      return translate('components.native-chat.composer.model', 'Model')
    case 'effort':
      return translate('components.native-chat.composer.effort', descriptor.label)
    case 'fastMode':
      return translate('components.native-chat.composer.fastMode', 'Fast mode')
    case 'serviceTier':
      return translate('components.native-chat.composer.speed', 'Speed')
    case 'thinking':
      return translate('components.native-chat.composer.thinking', 'Thinking')
    default:
      return descriptor.label
  }
}

export function nativeChatSessionChoiceLabel(
  choice: SessionOptionSelectChoice,
  optionId?: string
): string {
  // `default` is only Standard inside a speed choice; other selects may use the value.
  if (optionId === 'serviceTier' && choice.value === 'default') {
    return translate('components.native-chat.composer.optionValue.standard', 'Standard')
  }
  switch (choice.value) {
    case 'minimal':
      return translate('components.native-chat.composer.optionValue.minimal', 'Minimal')
    case 'low':
      return translate('components.native-chat.composer.optionValue.low', 'Low')
    case 'medium':
      return translate('components.native-chat.composer.optionValue.medium', 'Medium')
    case 'high':
      return translate('components.native-chat.composer.optionValue.high', 'High')
    case 'xhigh':
      return translate('components.native-chat.composer.optionValue.xhigh', 'Extra high')
    case 'max':
      return translate('components.native-chat.composer.optionValue.max', 'Max')
    case 'ultra':
      return translate('components.native-chat.composer.optionValue.ultra', 'Ultra')
    default:
      return choice.label
  }
}

export function nativeChatSessionChoiceShortLabel(
  choice: SessionOptionSelectChoice,
  optionId?: string
): string {
  switch (choice.value) {
    case 'minimal':
      return translate('components.native-chat.composer.optionValueShort.minimal', 'Min')
    case 'medium':
      return translate('components.native-chat.composer.optionValueShort.medium', 'Med')
    case 'xhigh':
      return translate('components.native-chat.composer.optionValueShort.xhigh', 'XHigh')
    default:
      return nativeChatSessionChoiceLabel(choice, optionId)
  }
}

export function nativeChatSessionOptionActionLabel(descriptor: SessionOptionDescriptor): string {
  // Why: flip-only without a baseline is an action — never claim On/Off.
  return descriptor.action?.type === 'toggle-command'
    ? translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', {
        value0: nativeChatSessionOptionLabel(descriptor).toLowerCase()
      })
    : translate('components.native-chat.composer.chooseInAgentPicker', 'Choose in agent picker…')
}

export function nativeChatSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined
): string | null {
  switch (reason) {
    case 'set-when-session-starts':
      return translate(
        'components.native-chat.composer.setWhenSessionStarts',
        'Set when the session starts.'
      )
    case 'available-after-session-start':
      return translate(
        'components.native-chat.composer.availableAfterSessionStarts',
        'Available after the session starts.'
      )
    case undefined:
      return null
  }
}

export function nativeChatModelPillLabel(descriptor: SessionOptionDescriptor): string {
  // The tooltip names the category; default sources still identify a model, while unknown sources do not.
  if (
    descriptor.valueSource === 'unknown' ||
    descriptor.kind.type !== 'select' ||
    !descriptor.kind.currentValue
  ) {
    return translate('components.native-chat.composer.model', 'Model')
  }
  return nativeChatSessionChoiceLabel(
    descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue) ?? {
      value: descriptor.kind.currentValue,
      label: descriptor.kind.currentValue
    }
  )
}

export function nativeChatOptionsPillTitle(
  descriptors: readonly SessionOptionDescriptor[]
): string {
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  // Why: an effort-backed group is primarily the effort picker, even when it also reports modes.
  return effort
    ? nativeChatSessionOptionLabel(effort)
    : translate('components.native-chat.composer.sessionOptions', 'Session options')
}

/** Join displayable option values after the model, e.g. High · Fast. */
export function nativeChatOptionValuesLabel(
  descriptors: readonly SessionOptionDescriptor[]
): string {
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown' || isDefaultServiceTier(descriptor)) {
      continue
    }
    if (descriptor.kind.type === 'select' && descriptor.kind.currentValue) {
      const choice = descriptor.kind.choices.find(
        (candidate) => candidate.value === descriptor.kind.currentValue
      )
      labels.push(
        (descriptor.id === 'effort'
          ? nativeChatSessionChoiceShortLabel
          : nativeChatSessionChoiceLabel)(
          choice ?? {
            value: descriptor.kind.currentValue,
            label: descriptor.kind.currentValue
          },
          descriptor.id
        )
      )
    } else if (descriptor.kind.type === 'boolean' && descriptor.kind.currentValue === true) {
      labels.push(
        descriptor.id === 'fastMode'
          ? translate('components.native-chat.composer.optionValue.fast', 'Fast')
          : nativeChatSessionOptionLabel(descriptor)
      )
    }
  }
  return labels.join(' · ')
}
