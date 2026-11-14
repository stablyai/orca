import { describe, expect, it } from 'vitest'
import { parseOmpModelList } from '../../../omp-model-list-probe'

const LISTING = JSON.stringify({
  models: [
    {
      provider: 'deepseek',
      id: 'deepseek-v4-pro',
      selector: 'deepseek/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      thinking: ['low', 'high', 'max']
    },
    {
      provider: 'minimax-cn',
      id: 'MiniMax-M3',
      selector: 'minimax-cn/MiniMax-M3',
      name: 'MiniMax M3'
    },
    // A repeat selector is one model, not two rows.
    { provider: 'deepseek', id: 'deepseek-v4-pro', selector: 'deepseek/deepseek-v4-pro' },
    // Older listings without `selector` still name the model by provider + id.
    { provider: 'openai', id: 'gpt-5.5' },
    // Rows that cannot be launched are dropped rather than guessed.
    { provider: 'zai', name: 'No id' },
    'not a row'
  ]
})

describe('omp model list probe', () => {
  it('parses selectors as ids, names as labels, and providers as descriptions', () => {
    expect(parseOmpModelList(LISTING)).toEqual([
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'deepseek' },
      { id: 'minimax-cn/MiniMax-M3', label: 'MiniMax M3', description: 'minimax-cn' },
      { id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai' }
    ])
  })

  it('tolerates an update notice printed ahead of the JSON', () => {
    const noisy = `Package updates are available. Run omp update\n${LISTING}\n`
    expect(parseOmpModelList(noisy).map(({ id }) => id)).toEqual([
      'deepseek/deepseek-v4-pro',
      'minimax-cn/MiniMax-M3',
      'openai/gpt-5.5'
    ])
  })

  it('ignores malformed JSON rows while keeping valid selectors', () => {
    expect(
      parseOmpModelList(
        JSON.stringify({
          models: [
            null,
            false,
            42,
            [],
            { provider: {}, id: [] },
            { selector: 5 },
            { selector: 'openai/gpt-5.5', name: null, provider: 'openai' }
          ]
        })
      )
    ).toEqual([{ id: 'openai/gpt-5.5', label: 'Openai GPT 5.5', description: 'openai' }])
    for (const value of ['null', 'true', '3', '"text"']) {
      expect(parseOmpModelList(value)).toEqual([])
    }
  })
})
