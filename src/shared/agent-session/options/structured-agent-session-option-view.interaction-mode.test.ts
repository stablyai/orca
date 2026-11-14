import { expect, it } from 'vitest'
import { CLAUDE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionOptionView
} from './structured-agent-session-option-view'

it('captures only accepted planning intent and keeps held Plan independent of model discovery', () => {
  const supported = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
    CLAUDE_SESSION_OPTION_CATALOG,
    {
      models: [],
      modelsKnown: false,
      current: { interactionMode: 'default', acceptedInputSources: {} }
    }
  )
  expect(structuredAgentSessionMessageSelection(supported)).not.toHaveProperty('interactionMode')
  const held = structuredAgentSessionOptionView({ ...supported, catalog: null }, undefined, {
    interactionMode: 'plan'
  })
  expect(structuredAgentSessionMessageSelection(held)).toEqual({ interactionMode: 'plan' })
  const changed = structuredAgentSessionOptionView(
    { ...held, catalog: CLAUDE_SESSION_OPTION_CATALOG },
    undefined,
    { model: 'unlisted-model' }
  )
  expect(structuredAgentSessionMessageSelection(changed)).toMatchObject({
    model: 'unlisted-model',
    interactionMode: 'plan'
  })
  const older = applyStructuredAgentSessionOptions(held, CLAUDE_SESSION_OPTION_CATALOG, {
    models: [],
    current: {}
  })
  expect(
    structuredAgentSessionOptionSnapshot(older).some((entry) => entry.id === 'interactionMode')
  ).toBe(false)
  expect(structuredAgentSessionMessageSelection(older)).not.toHaveProperty('interactionMode')
})
