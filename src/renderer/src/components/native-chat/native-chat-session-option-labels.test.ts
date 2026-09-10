import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import {
  nativeChatModelPillLabel,
  nativeChatSessionChoiceLabel
} from './native-chat-session-option-labels'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  buildNativeChatSessionOptionSnapshot,
  withTrackedNativeChatModel
} from '../../../../shared/native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'

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

  it('withholds a launch flag no list carried, end to end from the builder', () => {
    // `worker-start --model claude-opus-5` tracks an id neither the discovered list nor
    // the seed carries, so the composer's pill must read the neutral category rather
    // than echoing back the string the launch was typed with.
    const record = createNativeChatSessionOptionRecord('claude')
    // `applied` is what seedNativeChatAppliedSessionOptions writes for a launch flag.
    record.model = { value: 'claude-opus-5', source: 'applied' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: withTrackedNativeChatModel(
        CLAUDE_SESSION_OPTION_CATALOG,
        CLAUDE_SESSION_OPTION_CATALOG.models,
        record
      ),
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })

    expect(nativeChatModelPillLabel(snapshot[0]!)).toBe('Model')
  })

  it('names a reported model the list cannot carry, end to end from the builder', () => {
    // The other half of the rule: Claude's own header named this model, so the pill shows
    // it even though no catalog carries it and the dropdown cannot offer it.
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'my-custom-model', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: withTrackedNativeChatModel(
        CLAUDE_SESSION_OPTION_CATALOG,
        CLAUDE_SESSION_OPTION_CATALOG.models,
        record
      ),
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })

    expect(nativeChatModelPillLabel(snapshot[0]!)).toBe('my-custom-model')
  })

  it('falls back to the raw id when the list no longer offers it', () => {
    // A discovered list can drop an id the record still tracks; showing the id beats
    // showing "Model" while a real model is running. Not a hand-fed shape: this is
    // exactly what the builder emits for a reported-but-unlisted model — the test
    // above drives the same descriptor through `buildNativeChatSessionOptionSnapshot`.
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
