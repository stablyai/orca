import { expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOptionsReadOwner } from './structured-agent-session-options-read-owner'
import { createStructuredSessionSelectionController } from '../selection/structured-agent-session-selection-operations'
import { createStructuredAgentSessionOptionState } from '../structured-agent-session-options'
import { structuredAgentSessionShownSnapshot } from '../view/structured-agent-session-option-view'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'

it('keeps retained catalog evidence across same-owner resets and retires failed/away observations', async () => {
  const seed = getAgentSessionOptionCatalog('codex')!
  const initial = () => createStructuredAgentSessionOptionState('codex', seed)
  const reader = createStructuredAgentSessionOptionsReadOwner(initial())
  const context = {
    owner: ['host', 'chat'],
    reset: ['live'],
    sessionId: 'chat',
    fence: 1,
    seed: initial,
    controller: createStructuredSessionSelectionController(() => {}),
    eligible: true,
    optionCatalog: seed,
    newLaunch: false,
    coherentCatalog: true,
    authority: () => 'same-host',
    isCurrent: () => true,
    request: async () => ({
      models: [],
      modelsKnown: false as const,
      sessionNeverStarted: true,
      current: { defaulted: [], acceptedInputSources: {} }
    })
  }
  const shown = () =>
    structuredAgentSessionShownSnapshot(reader.getSnapshot().optionState).find(
      ({ id }) => id === 'model'
    )?.kind.currentValue
  const catalog = {
    origin: 'probe' as const,
    fetchedAt: 1,
    listingNamesConfiguredModel: true,
    models: [
      {
        id: 'gpt-native',
        label: 'GPT Native',
        isDefault: true,
        defaultEffort: 'medium',
        efforts: [{ value: 'medium', label: 'Medium' }]
      }
    ]
  }
  let detach = reader.attach(context)
  reader.receiveCatalog(catalog, 'settled')
  await vi.waitFor(() => expect(shown()).toBe('gpt-native'))
  detach()
  detach = reader.attach({ ...context, reset: ['unverifiable'] })
  await vi.waitFor(() => expect(reader.getSnapshot().optionState.sessionNeverStarted).toBe(true))
  expect(shown()).toBe('gpt-native')
  reader.receiveCatalog(null, 'settled')
  expect(shown()).toBeUndefined()
  detach()
  detach = reader.attach({ ...context, reset: ['live-again'] })
  await vi.waitFor(() => expect(reader.getSnapshot().optionState.sessionNeverStarted).toBe(true))
  expect(shown()).toBeUndefined()
  reader.receiveCatalog(catalog, 'settled')
  expect(shown()).toBe('gpt-native')
  reader.markAway()
  expect(shown()).toBeUndefined()
  reader.receiveCatalog(catalog, 'settled')
  expect(shown()).toBeUndefined()
  detach()
})
