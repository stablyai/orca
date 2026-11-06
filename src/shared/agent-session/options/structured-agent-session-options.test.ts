import { describe, expect, it } from 'vitest'
import { OMP_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-omp'
import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import {
  CODEX_SESSION_OPTION_CATALOG,
  CLAUDE_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import '../../native-chat/input/native-chat-session-option-snapshot'
import '../../native-chat/input/native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from './structured-agent-session-option-snapshot'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionMessageSelection
} from './structured-agent-session-option-view'

function viewModel(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
) {
  const model = structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(state, seed, held)
  ).find((descriptor) => descriptor.id === 'model')
  return model?.kind.type === 'select' ? model.kind.currentValue : undefined
}

describe('structured agent session options', () => {
  it('fills unknown OpenCode menus without changing choices or replacing a live known-empty menu', () => {
    const seed = structuredAgentSessionSeedCatalog('opencode2')
    const row = { id: 'provider/model', label: 'Live label', isDefault: false, efforts: [] }
    const current = {
      model: row.id,
      effort: 'high',
      acceptedInputSources: { model: 'saved' as const, effort: 'saved' as const }
    }
    const unknown = { models: [{ ...row, effortsKnown: false as const }], current }
    let state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('opencode2', seed),
      seed,
      unknown
    )
    const catalog = {
      origin: 'probe' as const,
      fetchedAt: 1,
      models: [
        {
          ...row,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
    state = applyStructuredAgentSessionModelCatalog(state, seed, catalog, { newLaunch: false })
    expect(
      state.catalog?.models[0]?.options.find((row) => row.id === 'effort')?.kind
    ).toMatchObject({ choices: catalog.models[0]!.efforts })
    state = applyStructuredAgentSessionOptions(state, seed, unknown)
    expect(state.catalog?.models[0]?.options.find((row) => row.id === 'effort')).toBeDefined()
    expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: row.id, effort: 'high' })
    state = applyStructuredAgentSessionOptions(state, seed, { models: [row], current })
    state = applyStructuredAgentSessionModelCatalog(state, seed, catalog, { newLaunch: false })
    expect(state.catalog?.models[0]?.options.find((row) => row.id === 'effort')).toBeUndefined()
    expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: row.id, effort: 'high' })
  })

  it('accepts a later catalog after a live answer becomes unknown', () => {
    const seed = structuredAgentSessionSeedCatalog('pi')
    const unknown = { models: [], modelsKnown: false as const, current: { defaulted: [] } }
    const models = [{ id: 'provider/model', label: 'Native label', isDefault: false, efforts: [] }]
    const catalog = { origin: 'probe' as const, fetchedAt: 1, models }
    const live = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      {
        models,
        current: { model: 'provider/model', confirmed: ['model'] }
      }
    )
    const resting = applyStructuredAgentSessionOptions(live, seed, {
      ...unknown,
      current: {
        model: 'provider/model',
        effort: 'high',
        permissionMode: 'ask',
        acceptedInputSources: { model: 'saved', effort: 'saved' },
        defaulted: []
      }
    })
    expect(resting.catalog).toBe(live.catalog)
    expect(resting.permissionMode).toBe('ask')
    expect(structuredAgentSessionMessageSelection(resting)).toEqual({
      model: 'provider/model',
      effort: 'high'
    })
    const refreshed = applyStructuredAgentSessionModelCatalog(
      resting,
      seed,
      {
        ...catalog,
        models: [...models, { ...models[0]!, id: 'provider/new' }]
      },
      { newLaunch: false }
    )
    expect(refreshed.catalog?.models.map(({ id }) => id)).toEqual([
      'provider/model',
      'provider/new'
    ])
  })

  it('keeps old-host empty answers authoritative when the knowledge marker is absent', () => {
    const seed = structuredAgentSessionSeedCatalog('pi')
    const empty = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('pi', seed),
      seed,
      { models: [], current: {} }
    )
    expect(
      applyStructuredAgentSessionModelCatalog(
        empty,
        seed,
        {
          origin: 'probe',
          fetchedAt: 1,
          models: [{ id: 'later', label: 'Later', isDefault: false, efforts: [] }]
        },
        { newLaunch: false }
      ).catalog?.models
    ).toEqual([])
  })

  it('keeps a missing model out of the picker and adopts a later report', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('omp'),
      OMP_SESSION_OPTION_CATALOG,
      { models: [], current: { effort: 'off', confirmed: ['effort'] } }
    )
    expect(state.catalog?.models).toEqual([])
    expect(structuredAgentSessionOptionSnapshot(state)).toEqual([])
    expect(state.record.values.model).toBeUndefined()

    const reported = applyStructuredAgentSessionOptions(state, OMP_SESSION_OPTION_CATALOG, {
      models: [{ id: 'reported-model', label: 'Reported Model', isDefault: true, efforts: [] }],
      current: { model: 'reported-model', confirmed: ['model'] }
    })
    expect(structuredAgentSessionOptionSnapshot(reported)[0]).toMatchObject({
      valueSource: 'reported',
      kind: {
        currentValue: 'reported-model',
        choices: [{ value: 'reported-model', label: 'Reported Model' }]
      }
    })
  })

  it('projects Fast mode only from positive session and model capability', () => {
    const supported = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            efforts: [],
            supportsFastMode: true
          }
        ],
        fastModeSupport: { supported: true },
        current: { model: 'account-model', fastMode: false, confirmed: ['fastMode'] }
      }
    )
    expect(structuredAgentSessionOptionSnapshot(supported)).toContainEqual(
      expect.objectContaining({
        id: 'fastMode',
        kind: { type: 'boolean', currentValue: false },
        valueSource: 'reported',
        settable: true
      })
    )

    const absent = applyStructuredAgentSessionOptions(supported, CODEX_SESSION_OPTION_CATALOG, {
      models: [
        {
          id: 'account-model',
          label: 'Account Model',
          isDefault: true,
          efforts: [],
          supportsFastMode: true
        }
      ],
      current: { model: 'account-model' }
    })
    expect(structuredAgentSessionOptionSnapshot(absent).map(({ id }) => id)).toEqual(['model'])
    expect(absent.record.values.fastMode).toBeUndefined()
  })

  it('shows the launch seed until the record names a model, and held picks over both', () => {
    const cold = createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG)
    const seeded = applyStructuredAgentSessionModelCatalog(
      cold,
      CODEX_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        models: [{ id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] }],
        fetchedAt: 1
      },
      { newLaunch: true }
    )
    const seed = { model: 'gpt-5.5' }
    expect(viewModel(seeded, seed, {})).toBe('gpt-5.5')
    // An omitted saved pick stays visible as its literal id; inventory does not replace it.
    expect(
      structuredAgentSessionOptionSnapshot(
        structuredAgentSessionOptionView(seeded, { model: 'gpt-next' }, {})
      )
    ).toEqual([
      expect.objectContaining({
        id: 'model',
        settable: true,
        valueSource: 'dispatched',
        kind: expect.objectContaining({
          currentValue: 'gpt-next',
          choices: expect.arrayContaining([
            { value: 'gpt-next', label: 'GPT Next', description: 'gpt-next' }
          ])
        })
      })
    ])
    // Known saved input stays named before discovery and after unavailable discovery.
    expect(viewModel(cold, seed, {})).toBe(seed.model)
    const settled = settleStructuredAgentSessionBuiltinCatalog(cold, false)
    expect(viewModel(settled, seed, {})).toBe(seed.model)
    expect(settleStructuredAgentSessionBuiltinCatalog(settled, false)).toBe(settled)
    expect(
      settleStructuredAgentSessionBuiltinCatalog({ ...settled, listingInProgress: true }, false)
        .listingInProgress
    ).toBe(false)
    // Derived only: the record itself never takes the seed.
    expect(seeded.record.values.model).toBeUndefined()
    const live = applyStructuredAgentSessionOptions(seeded, CODEX_SESSION_OPTION_CATALOG, {
      models: [{ id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', isDefault: true, efforts: [] }],
      current: { model: 'gpt-5.6-luna', confirmed: ['model'] }
    })
    expect(viewModel(live, seed, {})).toBe('gpt-5.6-luna')
    expect(viewModel(live, seed, { model: 'gpt-5.5' })).toBe('gpt-5.5')
    expect(live.record.values.model?.value).toBe('gpt-5.6-luna')
  })
})

it.each([false, true])(
  'keeps queried origins when installed metadata arrives, preloaded=%s',
  (preloaded) => {
    const launch = { newLaunch: true, coherentCatalog: true }
    const models = [
      {
        id: 'model-a',
        label: 'Model A',
        isDefault: true,
        defaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ]
    const catalog = {
      origin: 'probe' as const,
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models
    }
    const seed = createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG)
    const state = applyStructuredAgentSessionOptions(
      preloaded
        ? applyStructuredAgentSessionModelCatalog(
            seed,
            CODEX_SESSION_OPTION_CATALOG,
            catalog,
            launch
          )
        : seed,
      CODEX_SESSION_OPTION_CATALOG,
      {
        models,
        current: {
          model: 'model-a',
          effort: 'high',
          defaulted: ['model', 'effort'],
          acceptedInputSources: {}
        }
      },
      launch
    )
    expect(structuredAgentSessionMessageSelection(state)).toEqual({})
    let refreshed = applyStructuredAgentSessionModelCatalog(
      state,
      CODEX_SESSION_OPTION_CATALOG,
      catalog,
      launch
    )
    refreshed = applyStructuredAgentSessionModelCatalog(
      refreshed,
      CODEX_SESSION_OPTION_CATALOG,
      catalog,
      launch
    )
    expect(structuredAgentSessionMessageSelection(refreshed)).toEqual({})
    const stale = { model: 'old-unlisted', effort: 'low' }
    expect(
      structuredAgentSessionMessageSelection(
        structuredAgentSessionOptionView(refreshed, stale, {}, stale)
      )
    ).toEqual({})
    expect(
      structuredAgentSessionMessageSelection(
        structuredAgentSessionOptionView(refreshed, stale, { effort: 'low' }, stale)
      )
    ).toEqual({ effort: 'low' })
    const legacy = applyStructuredAgentSessionOptions(
      refreshed,
      CODEX_SESSION_OPTION_CATALOG,
      {
        models,
        current: { model: 'model-a', effort: 'high' }
      },
      launch
    )
    expect(
      applyStructuredAgentSessionModelCatalog(legacy, CODEX_SESSION_OPTION_CATALOG, catalog, launch)
        .acceptedInputSources
    ).toBeUndefined()
  }
)

it('rederives unanswered catalog policy while preserving stronger input and queried origins', () => {
  const launch = { newLaunch: true, coherentCatalog: true }
  const catalog = {
    origin: 'probe' as const,
    fetchedAt: 1,
    listingNamesConfiguredModel: true,
    fastModeSupport: { supported: true as const },
    models: [
      {
        id: 'opus',
        label: 'Opus',
        isDefault: true,
        supportsFastMode: true,
        defaultEffort: 'high',
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      }
    ]
  }
  const seed = CLAUDE_SESSION_OPTION_CATALOG
  const initial = applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('claude', seed),
    seed,
    catalog,
    launch
  )
  expect(structuredAgentSessionMessageSelection(initial)).toEqual({
    model: 'opus',
    fastMode: 'false'
  })
  const noDefault = { ...catalog, listingNamesConfiguredModel: false }
  expect(
    applyStructuredAgentSessionModelCatalog(initial, seed, noDefault, launch).acceptedInputSources
  ).toEqual({ fastMode: 'policy' })
  for (const fastMode of ['true', 'false']) {
    let chosen = commitStructuredAgentSessionOption(initial, 'model', 'unlisted', 'seeded')
    chosen = commitStructuredAgentSessionOption(chosen, 'effort', 'low')
    chosen = commitStructuredAgentSessionOption(chosen, 'fastMode', fastMode, 'seeded')
    const refreshed = applyStructuredAgentSessionModelCatalog(chosen, seed, noDefault, launch)
    expect(refreshed.acceptedInputSources).toEqual({
      model: 'seeded',
      effort: 'picked',
      fastMode: 'seeded'
    })
    expect(structuredAgentSessionMessageSelection(refreshed)).toEqual({
      model: 'unlisted',
      effort: 'low',
      fastMode
    })
  }
  const answered = applyStructuredAgentSessionOptions(
    initial,
    seed,
    {
      models: catalog.models,
      current: {
        model: 'opus',
        effort: 'low',
        fastMode: false,
        acceptedInputSources: { model: 'saved', effort: 'saved', fastMode: 'policy' },
        defaulted: []
      }
    },
    launch
  )
  const refreshed = applyStructuredAgentSessionModelCatalog(answered, seed, noDefault, launch)
  expect(refreshed.acceptedInputSources).toEqual(answered.acceptedInputSources)
  expect(structuredAgentSessionMessageSelection(refreshed)).toEqual({
    model: 'opus',
    effort: 'low',
    fastMode: 'false'
  })
})
