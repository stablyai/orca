import { expect, it } from 'vitest'
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
