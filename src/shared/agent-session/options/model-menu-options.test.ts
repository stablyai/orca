import { expect, it } from 'vitest'
import recording from '../../fixtures/agent-picker-cli-recordings.json'
import { modelMenuOptions, type ModelMenuInput } from './model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'

const seed = getAgentSessionOptionLaunchCatalog('codex')!
const input: ModelMenuInput = {
  agent: 'codex',
  surface: 'chat',
  seed,
  newLaunch: true,
  seedsModel: true,
  coherentCatalog: true
}
const recorded: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: true,
  models: recording.modelList.data.map((row) => ({
    id: row.id,
    label: row.displayName,
    isDefault: true,
    defaultEffort: row.defaultReasoningEffort,
    efforts: row.supportedReasoningEfforts.map((effort) => ({
      value: effort.reasoningEffort,
      label: effort.reasoningEffort
    }))
  }))
}

it('uses listed membership and live efforts, including when a seed names the same model', () => {
  const menu = modelMenuOptions(recorded, {
    ...input,
    seed: {
      ...seed,
      models: [
        {
          id: 'gpt-5.6-sol',
          label: 'Seed',
          options: [
            {
              id: 'effort',
              label: 'Effort',
              kind: {
                type: 'select',
                choices: [{ value: 'seed-only', label: 'Seed' }],
                defaultValue: 'seed-only'
              },
              apply: {}
            }
          ]
        }
      ]
    },
    saved: { model: 'gpt-5.6-sol' }
  })
  expect(menu.rows.map((row) => row.id)).toEqual(['gpt-5.6-sol'])
  expect(menu.rows[0].efforts.map((row) => row.value)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ])
  expect(menu.descriptors.find((row) => row.id === 'effort')?.kind).toMatchObject({
    choices: [
      { value: 'low' },
      { value: 'medium' },
      { value: 'high' },
      { value: 'xhigh' },
      { value: 'max' },
      { value: 'ultra' }
    ]
  })
})

it('distinguishes listing, unavailable discovery, coherent empty and legacy empty', () => {
  const listing = modelMenuOptions({ origin: 'unknown', listingInProgress: true }, input)
  expect(listing.status).toBe('listing')
  expect(listing.rows).toEqual([])
  expect(listing.descriptors.find((row) => row.id === 'model')?.settable).toBe(false)
  for (const answer of [undefined, { origin: 'unknown' } as const]) {
    expect(modelMenuOptions(answer, input).status).toBe('builtin')
    expect(modelMenuOptions(answer, input).rows.length).toBeGreaterThan(0)
  }
  expect(modelMenuOptions({ origin: 'probe', fetchedAt: 1, models: [] }, input)).toMatchObject({
    status: 'listed',
    rows: []
  })
  expect(
    modelMenuOptions(
      { origin: 'probe', fetchedAt: 1, models: [] },
      { ...input, coherentCatalog: false }
    ).status
  ).toBe('builtin')
  expect(
    modelMenuOptions(recorded, { ...input, coherentCatalog: false }).rows.map((row) => row.id)
  ).toEqual(['gpt-5.6-sol'])
})

it('retains gateway rows even when the host also reports unavailable metadata', () => {
  const menu = modelMenuOptions({ ...recorded, unavailable: { reason: 'notSignedIn' } }, input)
  expect(menu.status).toBe('listed')
  expect(menu.rows.map((row) => row.id)).toEqual(['gpt-5.6-sol'])
  expect(menu.rows[0].efforts.map((row) => row.value)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ])
})

it('keeps a literal saved unlisted model and effort read-only', () => {
  const menu = modelMenuOptions(recorded, {
    ...input,
    saved: { model: 'retired-account-model', effort: 'old-level' }
  })
  expect(menu.descriptors.find((row) => row.id === 'model')?.kind).toMatchObject({
    currentValue: 'retired-account-model',
    choices: expect.arrayContaining([
      {
        value: 'retired-account-model',
        label: 'retired-account-model',
        description: 'retired-account-model'
      }
    ])
  })
  expect(menu.descriptors.find((row) => row.id === 'effort')).toMatchObject({
    settable: false,
    kind: { currentValue: 'old-level', choices: [{ value: 'old-level', label: 'old-level' }] }
  })
})

it('excludes chat-only efforts on CLI surfaces and retains Config default execution modes', () => {
  const live = {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      {
        id: 'live',
        label: 'Live',
        isDefault: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ],
        chatEfforts: [{ value: 'ultracode', label: 'Ultracode' }]
      }
    ]
  } as const
  for (const surface of ['terminal', 'textGeneration'] as const) {
    const menu = modelMenuOptions(
      {
        ...live,
        models: [...live.models].map((row) => ({
          ...row,
          efforts: [...row.efforts],
          chatEfforts: [...row.chatEfforts]
        }))
      },
      { ...input, surface, saved: { model: 'live' } }
    )
    expect(menu.descriptors.find((row) => row.id === 'effort')?.kind).toMatchObject({
      choices: [{ value: 'low' }, { value: 'high' }]
    })
  }
  const ownSeed = { ...seed, models: [{ id: 'default', label: 'Config default', options: [] }] }
  const pi = modelMenuOptions(recorded, { ...input, agent: 'pi', seed: ownSeed })
  expect(pi.rows.map((row) => row.id)).toEqual(['default', 'gpt-5.6-sol'])
  const cursor = modelMenuOptions(undefined, {
    ...input,
    agent: 'cursor',
    seed: getAgentSessionOptionLaunchCatalog('cursor')!
  })
  expect(cursor.rows.some((row) => row.id === 'auto')).toBe(true)
})
