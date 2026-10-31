import { describe, expect, it } from 'vitest'
import { structuredAgentSessionSendSelection } from './structured-agent-session-option-view'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption
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
  it.each(['codex', 'pi'] as const)(
    '%s: pending inventory offers no built-ins and retains an applicable good list',
    (agent) => {
      const seed = structuredAgentSessionSeedCatalog(agent)!
      const state = createStructuredAgentSessionOptionState(agent, seed)
      const pending: AgentSessionModelCatalogResult = { origin: 'unknown', listingInProgress: true }
      const launch = { newLaunch: true, coherentCatalog: true }
      const cold = applyStructuredAgentSessionModelCatalog(state, seed, pending, launch)
      expect(cold.catalogSource).toBe('seed')
      expect(structuredAgentSessionOptionSnapshot(cold)[0]).toMatchObject({
        settable: false,
        kind: { choices: [] }
      })
      const good = applyStructuredAgentSessionModelCatalog(state, seed, HOST_CATALOG, launch)
      const refresh = applyStructuredAgentSessionModelCatalog(good, seed, pending, launch)
      expect(refresh.catalog).toBe(good.catalog)
      expect(refresh.catalogSource).toBe(good.catalogSource)
      const unavailable = applyStructuredAgentSessionModelCatalog(
        cold,
        seed,
        { origin: 'unknown' },
        launch
      )
      expect(unavailable.catalogSource).toBe('builtin')
      expect(unavailable.listingInProgress).toBe(false)
    }
  )

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

  it('settles on the built-in list on an unknown host answer, and keeps a host list', () => {
    const seeded = createStructuredAgentSessionOptionState('codex', SEED)
    for (const answer of [{ origin: 'unknown' as const }]) {
      const settled = applyStructuredAgentSessionModelCatalog(seeded, SEED, answer, LAUNCH)
      expect(settled.catalogSource).toBe('builtin')
      expect(settled.catalog).toBe(seeded.catalog)
      const hosted = applyStructuredAgentSessionModelCatalog(seeded, SEED, HOST_CATALOG, LAUNCH)
      expect(applyStructuredAgentSessionModelCatalog(hosted, SEED, answer, LAUNCH)).toBe(hosted)
    }
  })

  it('keeps known empty inventory distinct from an unavailable observation', () => {
    const seeded = createStructuredAgentSessionOptionState('codex', SEED)
    const hosted = applyStructuredAgentSessionModelCatalog(seeded, SEED, HOST_CATALOG, LAUNCH)
    const empty = applyStructuredAgentSessionModelCatalog(
      hosted,
      SEED,
      { origin: 'probe', models: [], fetchedAt: 2 },
      { ...LAUNCH, coherentCatalog: true }
    )
    expect(empty.catalog?.models).toEqual([])
    expect(empty.record).toBe(hosted.record)
    expect(
      applyStructuredAgentSessionModelCatalog(hosted, SEED, { origin: 'unknown' }, LAUNCH)
    ).toBe(hosted)
  })

  it.each([
    ['codex', false],
    ['pi', true]
  ] as const)(
    '%s keeps live controls usable after a warm listing, options, and terminal receipt',
    (agent, coherentCatalog) => {
      const seed = structuredAgentSessionSeedCatalog(agent)!
      const efforts = [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
      const models = [
        {
          id: 'A',
          label: 'A',
          isDefault: true,
          efforts,
          serviceTiers: [{ value: 'priority', label: 'Fast' }]
        },
        { id: 'B', label: 'B', isDefault: false, efforts, supportsFastMode: true }
      ]
      const launch = { ...LAUNCH, coherentCatalog }
      const pending = applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState(agent, seed),
        seed,
        { origin: 'probe', models, fetchedAt: 1, listingInProgress: true },
        launch
      )
      const live = applyStructuredAgentSessionOptions(
        pending,
        seed,
        {
          models,
          fastModeSupport: { supported: true },
          current: { model: 'A', effort: 'low', serviceTier: 'default', defaulted: [] }
        },
        launch
      )
      const settled = applyStructuredAgentSessionModelCatalog(
        live,
        seed,
        { origin: 'probe', models: [models[0]!], fetchedAt: 2 },
        launch
      )
      expect(settled.listingInProgress).not.toBe(true)
      expect(canSetStructuredAgentSessionOption(settled, 'effort', 'high')).toBe(true)
      expect(canSetStructuredAgentSessionOption(settled, 'serviceTier', 'priority')).toBe(true)
      const fast = commitStructuredAgentSessionOption(settled, 'model', 'B')
      expect(canSetStructuredAgentSessionOption(fast, 'fastMode', true)).toBe(true)
    }
  )
})

it('keeps one flat selection across inventory/answer arrival order and child replacement', () => {
  for (const inventoryFirst of [true, false]) {
    let state = commitStructuredAgentSessionOption(
      applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('claude', SEED),
        SEED,
        HOST_CATALOG,
        LAUNCH
      ),
      'model',
      'omitted'
    )
    state = commitStructuredAgentSessionOption(state, 'effort', 'high')
    const inventory = (current: typeof state) =>
      applyStructuredAgentSessionModelCatalog(current, SEED, HOST_CATALOG, LAUNCH)
    const answer = (current: typeof state) =>
      applyStructuredAgentSessionOptions(current, SEED, {
        models: HOST_CATALOG.models,
        listedModelIds: ['gpt-hosted'],
        current: { model: 'omitted', effort: 'high' }
      })
    state = inventoryFirst ? answer(inventory(state)) : inventory(answer(state))
    expect(structuredAgentSessionSendSelection(state)).toMatchObject({
      model: 'omitted',
      effort: 'high'
    })
    // A replacement child drops live capabilities while the conversation keeps its flat record.
    state = { ...createStructuredAgentSessionOptionState('claude', SEED), record: state.record }
    state = inventory(state)
    expect(structuredAgentSessionSendSelection(state)).toMatchObject({
      model: 'omitted',
      effort: 'high'
    })
  }
})
