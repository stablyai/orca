import { expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../structured-agent-session-options'
import { structuredAgentSessionMessageSelection } from '../view/structured-agent-session-option-view'
import { canSetStructuredAgentSessionOption } from '../view/structured-agent-session-option-snapshot'

it('keeps native and custom agent observations out of the next message selection', () => {
  const catalog = getAgentSessionOptionCatalog('opencode2')!
  for (const reportedAgent of [
    { id: 'plan', name: 'Plan' },
    { id: 'reviewer', name: 'Reviewer' }
  ]) {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('opencode2', catalog),
      catalog,
      {
        models: [],
        interactionModes: ['default', 'plan'],
        current: { interactionMode: 'default', reportedAgent, acceptedInputSources: {} }
      }
    )
    expect(structuredAgentSessionMessageSelection(state)).toEqual({})
  }
})

it('preserves the saved Plan request when the native agent and its available choices change', () => {
  const catalog = getAgentSessionOptionCatalog('opencode')!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('opencode', catalog),
    catalog,
    {
      models: [],
      interactionModes: ['default'],
      current: {
        interactionMode: 'plan',
        reportedAgent: { id: 'reviewer', name: 'Reviewer' },
        acceptedInputSources: { interactionMode: 'saved' }
      }
    }
  )
  expect(structuredAgentSessionMessageSelection(state)).toEqual({ interactionMode: 'plan' })
  expect(canSetStructuredAgentSessionOption(state, 'interactionMode', 'plan')).toBe(false)
  expect(canSetStructuredAgentSessionOption(state, 'interactionMode', 'default')).toBe(true)
})
