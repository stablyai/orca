import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog,
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

// HOST_CATALOG omits `listingNamesConfiguredModel`, as an older host's does.
const LAUNCH = { newLaunch: true }

describe('structured option state from the host model catalog', () => {
  it('renders the quiet placeholder before the host answers, never a built-in label', () => {
    const state = createStructuredAgentSessionOptionState('codex', SEED)
    expect(structuredAgentSessionOptionSnapshot(state)).toEqual([
      expect.objectContaining({
        id: 'model',
        valueSource: 'unknown',
        settable: false,
        kind: { type: 'select', choices: [] }
      })
    ])
  })

  it('makes the built-in list pickable, naming nothing, once the host says it has none', () => {
    const state = settleStructuredAgentSessionBuiltinCatalog(
      createStructuredAgentSessionOptionState('codex', SEED)
    )
    expect(state.catalogSource).toBe('builtin')
    const model = structuredAgentSessionOptionSnapshot(state).find((d) => d.id === 'model')!
    expect(model.kind.type === 'select' && model.kind.choices.length).toBeGreaterThan(0)
    expect(model.settable).toBe(true)
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
      { newLaunch: false }
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

  it('follows the host on whether its listed default is what a new chat runs', () => {
    const currentModel = (listingNamesConfiguredModel: boolean): unknown => {
      const state = applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('codex', SEED),
        SEED,
        { ...HOST_CATALOG, listingNamesConfiguredModel },
        LAUNCH
      )
      const model = structuredAgentSessionOptionSnapshot(state).find((d) => d.id === 'model')!
      return model.kind.type === 'select' ? model.kind.currentValue : null
    }
    expect(currentModel(true)).toBe('gpt-hosted')
    // A workspace whose own config may pick another model: the host says so, over the seed.
    expect(currentModel(false)).toBeUndefined()
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

  it('settles on the built-in list on an unknown or empty host answer, and keeps a host list', () => {
    const seeded = createStructuredAgentSessionOptionState('codex', SEED)
    for (const answer of [
      { origin: 'unknown' as const },
      { origin: 'probe' as const, models: [], fetchedAt: 1 }
    ]) {
      const settled = applyStructuredAgentSessionModelCatalog(seeded, SEED, answer, LAUNCH)
      expect(settled.catalogSource).toBe('builtin')
      expect(settled.catalog).toBe(seeded.catalog)
      const hosted = applyStructuredAgentSessionModelCatalog(seeded, SEED, HOST_CATALOG, LAUNCH)
      expect(applyStructuredAgentSessionModelCatalog(hosted, SEED, answer, LAUNCH)).toBe(hosted)
    }
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
