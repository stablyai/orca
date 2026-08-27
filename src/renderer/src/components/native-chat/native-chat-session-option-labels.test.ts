import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatPermissionModePillLabel,
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

describe('nativeChatSessionChoiceLabel — permission mode', () => {
  it('labels permission-mode choices', () => {
    expect(
      nativeChatSessionChoiceLabel({ value: 'bypassPermissions', label: 'raw' }, 'permissionMode')
    ).toBe('Bypass permissions')
    expect(
      nativeChatSessionChoiceLabel({ value: 'acceptEdits', label: 'raw' }, 'permissionMode')
    ).toBe('Accept edits')
  })

  // Why: Cursor ships a model whose value is literally `auto`. An unscoped
  // switch would relabel it from the catalog's own text in every locale.
  it('leaves a model choice named auto to the catalog label', () => {
    expect(nativeChatSessionChoiceLabel({ value: 'auto', label: 'Auto (Cursor)' }, 'model')).toBe(
      'Auto (Cursor)'
    )
    expect(nativeChatSessionChoiceLabel({ value: 'auto', label: 'Auto (Cursor)' })).toBe(
      'Auto (Cursor)'
    )
  })

  it('still labels effort choices without an option id', () => {
    expect(nativeChatSessionChoiceLabel({ value: 'xhigh', label: 'raw' })).toBe('Extra high')
  })

  it('falls back to the catalog label for an unknown mode value', () => {
    expect(
      nativeChatSessionChoiceLabel({ value: 'dontAsk', label: 'Do not ask' }, 'permissionMode')
    ).toBe('Do not ask')
  })
})

function permissionModeDescriptor(currentValue: string): SessionOptionDescriptor {
  return {
    id: 'permissionMode',
    label: 'Mode',
    kind: {
      type: 'select',
      currentValue,
      choices: [
        { value: 'manual', label: 'Manual' },
        { value: 'plan', label: 'Plan' }
      ]
    },
    valueSource: 'reported',
    settable: true
  }
}

function effortDescriptor(currentValue: string): SessionOptionDescriptor {
  return {
    id: 'effort',
    label: 'Effort',
    kind: {
      type: 'select',
      currentValue,
      choices: [{ value: currentValue, label: currentValue }]
    },
    valueSource: 'applied',
    settable: true
  }
}

describe('nativeChatOptionsPillLabel', () => {
  it('names a lone unknown effort control explicitly', () => {
    expect(nativeChatOptionsPillLabel([effortDescriptor('high')])).toBe('High')
  })

  it('falls back to a generic title when nothing contributes a label', () => {
    expect(
      nativeChatOptionsPillLabel([{ ...effortDescriptor('high'), valueSource: 'unknown' }])
    ).toBe('Effort')
  })
})

describe('nativeChatPermissionModePillLabel', () => {
  it('shows the current mode, including the manual default', () => {
    expect(nativeChatPermissionModePillLabel(permissionModeDescriptor('manual'))).toBe('Manual')
    expect(nativeChatPermissionModePillLabel(permissionModeDescriptor('plan'))).toBe('Plan')
  })

  it('falls back to the localized "Mode" label when the value source is unknown', () => {
    expect(
      nativeChatPermissionModePillLabel({
        ...permissionModeDescriptor('manual'),
        valueSource: 'unknown'
      })
    ).toBe('Mode')
  })

  it('falls back to the choice catalog label for an unrecognized mode value', () => {
    expect(
      nativeChatPermissionModePillLabel({
        ...permissionModeDescriptor('dontAsk'),
        kind: {
          type: 'select',
          currentValue: 'dontAsk',
          choices: [
            { value: 'manual', label: 'Manual' },
            { value: 'plan', label: 'Plan' },
            { value: 'dontAsk', label: 'Do not ask' }
          ]
        }
      })
    ).toBe('Do not ask')
  })
})
