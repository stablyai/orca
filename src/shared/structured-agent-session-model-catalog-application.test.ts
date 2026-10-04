import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const SEED = getAgentSessionOptionCatalog('codex')!

const HOST_CATALOG: AgentSessionModelCatalogResult = {
  origin: 'live-session',
  models: [
    {
      id: 'gpt-hosted',
      label: 'GPT Hosted',
      isDefault: true,
      defaultEffort: 'high',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    }
  ],
  fetchedAt: 1_000
}

const LAUNCH = { namesDefault: true }

describe('structured option state from the host model catalog', () => {
  it('renders a pickable snapshot from the seed before any host or live answer', () => {
    const state = createStructuredAgentSessionOptionState('codex', SEED)
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    const model = snapshot.find((descriptor) => descriptor.id === 'model')!
    expect(model.kind.type === 'select' && model.kind.choices.length).toBeGreaterThan(0)
    expect(model.settable).toBe(true)
    // The seed cannot name the CLI's own default, so nothing reads as chosen.
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBeUndefined()
  })

  it('upgrades the seed with host models as a provisional, uncommitted default', () => {
    const state = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', SEED),
      SEED,
      HOST_CATALOG,
      LAUNCH
    )
    expect(state.catalogSource).toBe('host')
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    const model = snapshot.find((descriptor) => descriptor.id === 'model')!
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-hosted')
    // Provisional provenance: a listing default, never a reported value.
    expect(model.valueSource).toBe('default')
  })

  it('lists host models but names no value for a session it did not launch', () => {
    // A reopened session may run a model picked in it, not the listing's default.
    const state = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', SEED),
      SEED,
      HOST_CATALOG,
      { namesDefault: false }
    )
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    const model = snapshot.find((descriptor) => descriptor.id === 'model')!
    expect(model.kind.type === 'select' && model.kind.choices.map((c) => c.value)).toEqual([
      'gpt-hosted'
    ])
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBeUndefined()
    const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
    expect(effort?.kind.type === 'select' ? effort.kind.currentValue : undefined).toBeUndefined()
  })

  it('names the default effort the listing states, and none it does not', () => {
    const effortOf = (catalog: AgentSessionModelCatalogResult) => {
      const state = applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('codex', SEED),
        SEED,
        catalog,
        LAUNCH
      )
      return structuredAgentSessionOptionSnapshot(state).find((d) => d.id === 'effort')!
    }
    const stated = effortOf(HOST_CATALOG)
    expect(stated.kind.type === 'select' ? stated.kind.currentValue : null).toBe('high')
    expect(stated.valueSource).toBe('default')
    const { defaultEffort: _stated, ...unstated } = HOST_CATALOG.models[0]!
    const silent = effortOf({ ...HOST_CATALOG, models: [unstated] })
    expect(silent.kind.type === 'select' ? silent.kind.currentValue : null).toBeUndefined()
    expect(silent.valueSource).toBe('unknown')
  })

  it('keeps the seed on an unknown or empty host answer', () => {
    const seeded = createStructuredAgentSessionOptionState('codex', SEED)
    expect(
      applyStructuredAgentSessionModelCatalog(seeded, SEED, { origin: 'unknown' }, LAUNCH)
    ).toBe(seeded)
    expect(
      applyStructuredAgentSessionModelCatalog(
        seeded,
        SEED,
        { origin: 'probe', models: [], fetchedAt: 1 },
        LAUNCH
      )
    ).toBe(seeded)
  })

  it('never downgrades a live catalog to a host one', () => {
    const live = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', SEED),
      SEED,
      {
        models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
        current: { model: 'gpt-live', confirmed: ['model'] }
      }
    )
    expect(live.catalogSource).toBe('live')
    expect(applyStructuredAgentSessionModelCatalog(live, SEED, HOST_CATALOG, LAUNCH)).toBe(live)
    const snapshot = structuredAgentSessionOptionSnapshot(live)
    const model = snapshot.find((descriptor) => descriptor.id === 'model')!
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBe('gpt-live')
  })
})
