import { expect, it } from 'vitest'
import { structuredAgentSessionDefaultModelChoice } from '../../structured-agent-session-default-model-choice'
import { CLAUDE_SESSION_OPTION_CATALOG } from './catalog-providers/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from './view/structured-agent-session-option-snapshot'
import { structuredAgentSessionMessageSelection } from './view/structured-agent-session-option-view'
import {
  nativeChatModelPillLabel,
  sayNativeChatSessionOptionEnglish
} from '../../native-chat/input/session-options/native-chat-session-option-labels'

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
  expect(model.reportedModel).toBe('claude-opus-4-8')
  expect(nativeChatModelPillLabel(model, sayNativeChatSessionOptionEnglish)).toBe('Claude Opus 4.8')
  expect(structuredAgentSessionMessageSelection(state)).toEqual({})
})
