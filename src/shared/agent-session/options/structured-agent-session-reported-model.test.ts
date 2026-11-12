import { expect, it } from 'vitest'
import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-antigravity'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
import { structuredAgentSessionMessageSelection } from './structured-agent-session-option-view'
import {
  nativeChatModelPillLabel,
  sayNativeChatSessionOptionEnglish
} from '../../native-chat/input/native-chat-session-option-labels'

it('uses the saved model for the shared picker and Send when an old host reports a different answering model', () => {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude'),
    CLAUDE_SESSION_OPTION_CATALOG,
    {
      models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: false, efforts: [] }],
      current: {
        model: 'claude-opus-5-5',
        reportedModel: 'claude-opus-4-8',
        defaulted: [],
        acceptedInputSources: { model: 'saved' }
      }
    }
  )
  const model = structuredAgentSessionOptionSnapshot(state).find((option) => option.id === 'model')!
  expect(nativeChatModelPillLabel(model, sayNativeChatSessionOptionEnglish)).toBe('Opus 5.5')
  expect(model.kind.currentValue).toBe('claude-opus-5-5')
  expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: 'claude-opus-5-5' })
})

it('shows Auto when the session lists no models, without capturing it for Send', () => {
  for (const current of [{ acceptedInputSources: {} }, {}]) {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('antigravity', ANTIGRAVITY_SESSION_OPTION_CATALOG),
      ANTIGRAVITY_SESSION_OPTION_CATALOG,
      { models: [], current }
    )
    const model = structuredAgentSessionOptionSnapshot(state).find(
      (option) => option.id === 'model'
    )!
    expect(nativeChatModelPillLabel(model, sayNativeChatSessionOptionEnglish)).toBe('Auto')
    expect(model.settable).toBe(false)
    expect(structuredAgentSessionMessageSelection(state)).not.toHaveProperty('model')
  }
})
