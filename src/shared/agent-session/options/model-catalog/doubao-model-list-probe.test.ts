import { expect, it } from 'vitest'
import { parseDoubaoModelList } from './doubao-model-list-probe'

it('keeps account defaults and supported effort levels attached to the listed model ID', () => {
  const models = parseDoubaoModelList(
    JSON.stringify({
      result: {
        type: 'model_list',
        models: [
          { id: '5', name: 'Pro', efforts: ['low', 'medium'], default_effort: 'medium' },
          {
            id: '5101',
            name: 'Flash',
            is_default: true,
            efforts: ['low', 'max'],
            default_effort: 'max'
          },
          { id: '6', name: 'No effort' }
        ]
      }
    })
  )
  expect(models).toEqual([
    {
      id: '5',
      label: 'Pro',
      thinkingLevels: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' }
      ],
      defaultThinkingLevel: 'medium'
    },
    {
      id: '5101',
      label: 'Flash',
      isDefault: true,
      thinkingLevels: [
        { id: 'low', label: 'low' },
        { id: 'max', label: 'max' }
      ],
      defaultThinkingLevel: 'max'
    },
    { id: '6', label: 'No effort', thinkingLevels: [] }
  ])
})
