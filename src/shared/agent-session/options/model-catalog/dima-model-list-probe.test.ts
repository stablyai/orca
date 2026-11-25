import { expect, it } from 'vitest'
import { dimaCatalogModels, dimaModelLaunchArgs } from './dima-model-list-probe'
import { DIMA_SESSION_OPTION_CATALOG } from '../catalog-providers/agent-session-option-catalog-dima'

it('keeps the provider and full model id through a picker selection', () => {
  const rows = dimaCatalogModels([
    { providerId: 'one', providerName: 'First', modelId: 'vendor/model', modelName: 'Chat' },
    { providerId: 'two', providerName: 'Second', modelId: 'vendor/model', modelName: 'Chat' }
  ])
  expect(rows.map(({ id, label }) => [label, dimaModelLaunchArgs(id)])).toEqual([
    ['Chat · First', ['--provider', 'one', '--model', 'vendor/model']],
    ['Chat · Second', ['--provider', 'two', '--model', 'vendor/model']]
  ])
})

it('gives a chat the full model id only when one provider lists it', () => {
  const listed = dimaCatalogModels([
    { providerId: 'one', modelId: 'vendor/model' },
    { providerId: 'two', modelId: 'vendor/model' },
    { providerId: 'two', modelId: 'vendor/only' }
  ]).map(({ id }) => id)
  expect(listed.map((id) => DIMA_SESSION_OPTION_CATALOG.chatModelId?.(id, listed))).toEqual([
    null,
    null,
    'vendor/only'
  ])
})
