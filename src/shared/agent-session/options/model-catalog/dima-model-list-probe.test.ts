import { expect, it } from 'vitest'
import { dimaCatalogModels, dimaModelLaunchArgs } from './dima-model-list-probe'

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
