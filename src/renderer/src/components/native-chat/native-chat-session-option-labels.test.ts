import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatSessionChoiceLabel
} from './native-chat-session-option-labels'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

function modelDescriptor(
  valueSource: SessionOptionDescriptor['valueSource'],
  currentValue?: string
): SessionOptionDescriptor {
  return {
    id: 'model',
    label: 'Model',
    valueSource,
    transport: 'catalog',
    settable: true,
    kind: {
      type: 'select',
      ...(currentValue ? { currentValue } : {}),
      choices: [{ value: 'grok-4.5', label: 'Grok 4.5' }]
    }
  }
}

describe('nativeChatModelPillLabel', () => {
  it('names a model the CLI defaulted to, not the bare category', () => {
    // This is the last step between `defaultModelIsCliDefault` and pixels: withholding
    // `default` here would silently undo the whole load-time default display.
    expect(nativeChatModelPillLabel(modelDescriptor('default', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('names a model the user picked', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('applied', 'grok-4.5'))).toBe('Grok 4.5')
  })

  it('withholds a value it has no evidence for', () => {
    expect(nativeChatModelPillLabel(modelDescriptor('unknown', 'grok-4.5'))).toBe('Model')
    expect(nativeChatModelPillLabel(modelDescriptor('default'))).toBe('Model')
  })

  it('falls back to the raw id when the list no longer offers it', () => {
    // A discovered list can drop an id the record still tracks; showing the id beats
    // showing "Model" while a real model is running.
    expect(nativeChatModelPillLabel(modelDescriptor('reported', 'grok-build'))).toBe('grok-build')
  })
})

describe('nativeChatSessionChoiceLabel', () => {
  it('routes ultra through the localized effort label', () => {
    nativeChatSessionChoiceLabel({ value: 'ultra', label: 'Ultra' })

    expect(translate).toHaveBeenCalledWith(
      'components.native-chat.composer.optionValue.ultra',
      'Ultra'
    )
  })
})

describe('nativeChatOptionsPillLabel', () => {
  const fast: SessionOptionDescriptor = {
    id: 'fastMode',
    label: 'Fast mode',
    kind: { type: 'boolean', currentValue: false },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }

  it.each([
    [false, 'high', 'High'],
    [true, 'high', 'High · Fast'],
    [false, 'xhigh', 'Extra high'],
    [false, 'custom-effort', 'custom-effort'],
    [false, undefined, 'Options']
  ] as const)('keeps reported effort %s / %s without adding controls', (enabled, value, label) => {
    const options = [{ ...fast, kind: { type: 'boolean' as const, currentValue: enabled } }]
    const original = structuredClone(options)
    expect(nativeChatOptionsPillLabel(options, value)).toBe(label)
    expect(options).toEqual(original)
  })

  it.each([
    ['reported', 'low', 'Low'],
    ['unknown', undefined, 'Effort']
  ] as const)('does not replace a %s effort descriptor', (valueSource, currentValue, label) => {
    const effort: SessionOptionDescriptor = {
      id: 'effort',
      label: 'Effort',
      category: 'thought_level',
      kind: { type: 'select', currentValue, choices: [] },
      valueSource,
      transport: 'agent-session',
      settable: false
    }
    expect(nativeChatOptionsPillLabel([effort, fast], 'high')).toBe(label)
  })
})
