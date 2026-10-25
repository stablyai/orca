import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelPillLabel,
  nativeChatOptionValuesLabel,
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
    // Keep naming a tracked model after discovery drops it; the running selection is still known.
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

describe('nativeChatSessionChoiceLabel for speed', () => {
  it('localizes Standard only inside the speed choice', () => {
    nativeChatSessionChoiceLabel({ value: 'default', label: 'Standard' }, 'serviceTier')
    expect(translate).toHaveBeenCalledWith(
      'components.native-chat.composer.optionValue.standard',
      'Standard'
    )
    expect(nativeChatSessionChoiceLabel({ value: 'default', label: 'Ask first' }, 'mode')).toBe(
      'Ask first'
    )
  })
})

describe('nativeChatOptionValuesLabel', () => {
  function speedDescriptor(currentValue: string): SessionOptionDescriptor {
    return {
      id: 'serviceTier',
      label: 'Speed',
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true,
      kind: {
        type: 'select',
        currentValue,
        choices: [
          { value: 'default', label: 'Standard' },
          { value: 'priority', label: 'Fast' },
          { value: 'ultrafast', label: 'Ultrafast' }
        ]
      }
    }
  }

  it('names a faster tier and leaves Standard out, as Fast off was', () => {
    expect(nativeChatOptionValuesLabel([speedDescriptor('ultrafast')])).toBe('Ultrafast')
    expect(nativeChatOptionValuesLabel([speedDescriptor('default')])).toBe('')
  })
})
