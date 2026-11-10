import { describe, expect, it } from 'vitest'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot,
  structuredAgentSessionSendSelection
} from './structured-agent-session-option-view'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  structuredAgentSessionOptionPicks,
  createStructuredAgentSessionOptionState,
  commitStructuredAgentSessionOption,
  settleStructuredAgentSessionBuiltinCatalog
} from './structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
import { cloneStructuredAgentSessionOptionRecord } from './structured-agent-session-option-state'

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

  it('records a running host listing without disabling controls drawn from data', () => {
    const efforts = [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
    const codexRows = [
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        isDefault: true,
        efforts,
        serviceTiers: [{ value: 'priority', label: 'Fast' }]
      },
      {
        id: 'gpt-5.5-mini',
        label: 'GPT-5.5 Mini',
        isDefault: false,
        efforts,
        supportsFastMode: true
      }
    ]
    const grokRows = [
      { id: 'grok-4.7', label: 'Grok 4.7', isDefault: true, efforts },
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: false, efforts }
    ]
    const listing: AgentSessionModelCatalogResult = { origin: 'unknown', listingInProgress: true }
    const launch = { newLaunch: true, coherentCatalog: true }
    const capabilities = (state: ReturnType<typeof createStructuredAgentSessionOptionState>) =>
      structuredAgentSessionOptionSnapshot(state).filter(({ id }) =>
        ['effort', 'serviceTier', 'fastMode'].includes(id)
      )
    const answered = (
      agent: 'codex' | 'grok',
      hostList: AgentSessionModelCatalogResult,
      models: typeof codexRows | typeof grokRows
    ) => {
      const seed = structuredAgentSessionSeedCatalog(agent)!
      const start = createStructuredAgentSessionOptionState(agent, seed)
      return applyStructuredAgentSessionOptions(
        applyStructuredAgentSessionModelCatalog(start, seed, hostList, launch),
        seed,
        {
          models,
          listedModelIds: models.map(({ id }) => id),
          fastModeSupport: { supported: true },
          current: { model: models[0]!.id, effort: 'low', serviceTier: 'default', defaulted: [] }
        },
        launch
      )
    }
    // Claude/Codex menus from a list the host is refreshing; Grok's from its own answer.
    const refreshing = answered(
      'codex',
      {
        origin: 'probe',
        models: codexRows,
        fetchedAt: 1,
        fastModeSupport: { supported: true },
        listingInProgress: true
      },
      codexRows
    )
    const own = answered('grok', listing, grokRows)
    for (const state of [
      refreshing,
      own,
      settleStructuredAgentSessionBuiltinCatalog(refreshing, true),
      settleStructuredAgentSessionBuiltinCatalog(own, true)
    ]) {
      expect(state.listingInProgress).toBe(true)
      expect(capabilities(state).map(({ id }) => id)).toContain('effort')
      expect(capabilities(state).every(({ settable }) => settable)).toBe(true)
    }
    expect(capabilities(refreshing).map(({ id }) => id)).toEqual(['effort', 'serviceTier'])
    const fast = commitStructuredAgentSessionOption(refreshing, 'model', 'gpt-5.5-mini')
    expect(capabilities(fast).find(({ id }) => id === 'fastMode')).toMatchObject({ settable: true })
    // An installed chat that answered before any list exists holds its effort, offering no choices.
    const unknown = answered('codex', listing, codexRows)
    expect(unknown.catalogSource).toBe('seed')
    expect(capabilities(unknown)).toEqual([
      expect.objectContaining({
        id: 'effort',
        settable: false,
        kind: expect.objectContaining({ currentValue: 'low', choices: [expect.anything()] })
      })
    ])
  })
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
    state = {
      ...state,
      record: cloneStructuredAgentSessionOptionRecord(state.record),
      catalog: SEED,
      catalogSource: 'seed',
      verifiedModelIds: undefined,
      reportedEffort: undefined,
      reportedPermissionMode: undefined
    }
    state = inventory(state)
    expect(structuredAgentSessionSendSelection(state)).toMatchObject({
      model: 'omitted',
      effort: 'high'
    })
  }
})

it('requires current session and explicit catalog proof, replacing each observation without inferring inputs', () => {
  const launch = { newLaunch: false, coherentCatalog: true }
  const value = (state: ReturnType<typeof createStructuredAgentSessionOptionState>) =>
    structuredAgentSessionShownSnapshot(state).find(({ id }) => id === 'model')?.kind.currentValue
  for (const catalogFirst of [false, true]) {
    const answer = (
      state: ReturnType<typeof createStructuredAgentSessionOptionState>,
      sessionNeverStarted?: boolean
    ) =>
      applyStructuredAgentSessionOptions(
        state,
        SEED,
        {
          models: [],
          modelsKnown: false,
          sessionNeverStarted,
          current: { defaulted: [], acceptedInputSources: {} }
        },
        launch
      )
    const listing = (
      state: ReturnType<typeof createStructuredAgentSessionOptionState>,
      listingNamesConfiguredModel?: boolean
    ) =>
      applyStructuredAgentSessionModelCatalog(
        state,
        SEED,
        { ...HOST_CATALOG, listingNamesConfiguredModel },
        launch
      )
    const start = createStructuredAgentSessionOptionState('codex', SEED)
    const known = catalogFirst
      ? answer(listing(start, true), true)
      : listing(answer(start, true), true)
    expect(value(known)).toBe('gpt-hosted')
    expect(structuredAgentSessionOptionPicks(known, { effort: 'high' }, true)).toEqual([
      { modelId: 'gpt-hosted', adoptModelAsLaunchDefault: false, optionId: 'effort', value: 'high' }
    ])
    expect(structuredAgentSessionMessageSelection(known)).toEqual({})
    for (const proof of [false, undefined]) {
      expect(value(listing(answer(known, proof), true))).toBeUndefined()
      expect(value(answer(listing(known, proof), true))).toBeUndefined()
    }
    const unknown = applyStructuredAgentSessionModelCatalog(
      known,
      SEED,
      { origin: 'unknown' },
      launch
    )
    expect(value(answer(unknown, true))).toBeUndefined()
    const unavailable = applyStructuredAgentSessionModelCatalog(
      known,
      SEED,
      {
        ...HOST_CATALOG,
        listingNamesConfiguredModel: true,
        unavailable: { reason: 'cliMissing' }
      },
      launch
    )
    expect(value(answer(unavailable, true))).toBeUndefined()
    const own = commitStructuredAgentSessionOption(known, 'model', 'own-unlisted')
    expect(value(listing(own, false))).toBe('own-unlisted')
  }
})

it('keeps existing new-launch default authority when its live catalog refresh cannot name a default', () => {
  const launch = { newLaunch: true, coherentCatalog: true }
  const listed = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('codex', SEED),
    SEED,
    { ...HOST_CATALOG, listingNamesConfiguredModel: true },
    launch
  )
  const live = applyStructuredAgentSessionOptions(
    listed,
    SEED,
    {
      models: HOST_CATALOG.models,
      current: { model: 'gpt-hosted', defaulted: ['model'], acceptedInputSources: {} }
    },
    launch
  )
  const refreshing = applyStructuredAgentSessionModelCatalog(
    live,
    SEED,
    {
      ...HOST_CATALOG,
      listingInProgress: true,
      listingNamesConfiguredModel: false,
      models: HOST_CATALOG.models.map((row) => ({ ...row, isDefault: false }))
    },
    launch
  )
  expect(
    structuredAgentSessionShownSnapshot(refreshing).find(({ id }) => id === 'model')?.kind
      .currentValue
  ).toBe('gpt-hosted')
})

it('offers only the speeds the model lists while a configured Flex keeps running', () => {
  const models = [
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: true,
      efforts: [{ value: 'low', label: 'Low' }],
      serviceTiers: [{ value: 'priority', label: 'Fast' }]
    }
  ]
  const host: AgentSessionModelCatalogResult = { origin: 'probe', models, fetchedAt: 1 }
  const seed = structuredAgentSessionSeedCatalog('codex')!
  const state = applyStructuredAgentSessionOptions(
    applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', seed),
      seed,
      host,
      LAUNCH
    ),
    seed,
    {
      models,
      listedModelIds: ['gpt-fast'],
      current: { model: 'gpt-fast', effort: 'low', serviceTier: 'flex', defaulted: [] }
    },
    LAUNCH
  )
  const speed = structuredAgentSessionOptionSnapshot(state).find(({ id }) => id === 'serviceTier')
  expect(speed?.kind).toEqual({
    type: 'select',
    currentValue: 'flex',
    choices: [
      { value: 'default', label: 'Standard' },
      { value: 'priority', label: 'Fast' }
    ]
  })
  expect(structuredAgentSessionMessageSelection(state).serviceTier).toBe('flex')
})
