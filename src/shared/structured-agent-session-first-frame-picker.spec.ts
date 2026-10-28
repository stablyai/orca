import { describe, expect, it } from 'vitest'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import { independentAgentModelCatalog } from './agent-model-catalog-ownership'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

// Every agent a runtime registers today; the main-side contract test walks the registrations.
const AGENTS = ['claude', 'codex', 'grok', 'opencode', 'pi'] as const

const HOST_CATALOG: AgentSessionModelCatalogResult = {
  origin: 'probe',
  models: [
    {
      id: 'model-listed',
      label: 'Model Listed',
      isDefault: true,
      defaultEffort: 'high',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  ],
  fetchedAt: 1_000
}

function firstFrame(
  agent: string,
  host: AgentSessionModelCatalogResult | null,
  launch = { newLaunch: true }
) {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const cold = createStructuredAgentSessionOptionState(agent, seed)
  const state = host ? applyStructuredAgentSessionModelCatalog(cold, seed, host, launch) : cold
  return { seed, state, snapshot: structuredAgentSessionOptionSnapshot(state) }
}

function currentValue(
  snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>,
  id: string
): string | undefined {
  const descriptor = snapshot.find((entry) => entry.id === id)
  return descriptor?.kind.type === 'select' ? descriptor.kind.currentValue : undefined
}

describe('the first frame of every agent’s picker', () => {
  it.each(AGENTS)(
    '%s: a cold or failed listing shows a model pill nobody can pick from',
    (agent) => {
      for (const host of [null, { origin: 'unknown' as const }]) {
        const { seed, state, snapshot } = firstFrame(agent, host)
        const model = snapshot.find((descriptor) => descriptor.id === 'model')
        expect(model).toBeDefined()
        if (seed.models.length === 0) {
          // An unpickable placeholder must never seed a launch.
          expect(model).toMatchObject({
            valueSource: 'unknown',
            settable: false,
            kind: { choices: [] }
          })
          expect(canSetStructuredAgentSessionOption(state, 'model', 'anything')).toBe(false)
        } else {
          // Built-in lists are presentation, never tracked picks.
          expect(state.record.values.model).toBeUndefined()
        }
      }
    }
  )

  it.each(AGENTS)(
    '%s: a new chat names the listed model and its effort when the host says it runs them',
    (agent) => {
      const { state, snapshot } = firstFrame(agent, {
        ...HOST_CATALOG,
        listingNamesConfiguredModel: true
      })
      expect(currentValue(snapshot, 'model')).toBe('model-listed')
      const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
      expect(effort?.kind.type === 'select' && effort.kind.choices.map((c) => c.value)).toEqual([
        'low',
        'high'
      ])
      expect(currentValue(snapshot, 'effort')).toBe('high')
      // Listing defaults describe the running default, not a saved next-launch pick.
      expect(snapshot.find((descriptor) => descriptor.id === 'model')?.valueSource).toBe('default')
      expect(state.record.values.model).toBeUndefined()
      // A reopened chat may run a model picked in it, so it names none.
      const reopened = firstFrame(
        agent,
        { ...HOST_CATALOG, listingNamesConfiguredModel: true },
        { newLaunch: false }
      )
      expect(currentValue(reopened.snapshot, 'model')).toBeUndefined()
    }
  )

  it.each(AGENTS)('%s: the live session corrects the host list', (agent) => {
    const { seed, state } = firstFrame(agent, HOST_CATALOG)
    const live = applyStructuredAgentSessionOptions(state, seed, {
      models: [{ id: 'model-live', label: 'Model Live', isDefault: false, efforts: [] }],
      current: { model: 'model-live', confirmed: ['model'] }
    })
    expect(live.catalogSource).toBe('live')
    expect(live.catalog?.models.map((model) => model.id)).toEqual(['model-live'])
    // Later host listings must not downgrade live-session answers.
    expect(
      applyStructuredAgentSessionModelCatalog(live, seed, HOST_CATALOG, { newLaunch: true })
    ).toBe(live)
    const refreshed = applyStructuredAgentSessionModelCatalog(live, seed, HOST_CATALOG, {
      newLaunch: true,
      coherentCatalog: true
    })
    if (independentAgentModelCatalog(agent)) {
      expect(refreshed.catalog?.models.map((model) => model.id)).toContain('model-listed')
      expect(refreshed.record).toBe(live.record)
      expect(currentValue(structuredAgentSessionOptionSnapshot(refreshed), 'model')).toBe(
        'model-live'
      )
    } else {
      expect(refreshed).toBe(live)
    }
  })
})
