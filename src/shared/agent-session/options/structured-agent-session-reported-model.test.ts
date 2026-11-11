import { structuredAgentSessionDefaultModelChoice } from '../../structured-agent-session-default-model-choice'
import { expect, it } from 'vitest'
import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-antigravity'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  commitStructuredAgentSessionOption
} from './structured-agent-session-options'
import { structuredAgentSessionReportsAtFence } from './structured-agent-session-runtime-reports'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
import { structuredAgentSessionMessageSelection } from './structured-agent-session-option-view'
import {
  nativeChatModelPillLabel,
  sayNativeChatSessionOptionEnglish
} from '../../native-chat/input/native-chat-session-option-labels'

it('shows the actual fallback in the shared composer pill while capturing the original model for Send', () => {
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
  expect(nativeChatModelPillLabel(model, sayNativeChatSessionOptionEnglish)).toBe('Opus 4.8')
  expect(model.kind.currentValue).toBe('claude-opus-5-5')
  expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: 'claude-opus-5-5' })
  expect(structuredAgentSessionReportsAtFence(state, 1, 2).reportedModel).toBeUndefined()
  expect(
    commitStructuredAgentSessionOption(state, 'model', 'claude-opus-5-5').reportedModel
  ).toBeUndefined()
  const oldHost = applyStructuredAgentSessionOptions(state, CLAUDE_SESSION_OPTION_CATALOG, {
    models: [],
    current: { model: 'claude-opus-5-5' }
  })
  expect(oldHost.reportedModel).toBeUndefined()
})

it('shows the reported execution model while retaining the saved Default choice', () => {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude'),
    CLAUDE_SESSION_OPTION_CATALOG,
    {
      models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', isDefault: true, efforts: [] }],
      current: {
        modelDefault: true,
        reportedModel: 'claude-opus-4-8',
        acceptedInputSources: {}
      }
    }
  )
  const model = {
    ...structuredAgentSessionOptionSnapshot(state).find((option) => option.id === 'model')!,
    defaultChoice: structuredAgentSessionDefaultModelChoice(state)
  }
  expect(model.defaultChoice?.selected).toBe(true)
  expect(nativeChatModelPillLabel(model, sayNativeChatSessionOptionEnglish)).toBe('Opus 4.8')
  expect(structuredAgentSessionMessageSelection(state)).toEqual({})
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
