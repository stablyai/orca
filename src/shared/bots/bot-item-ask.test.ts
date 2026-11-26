import { describe, expect, it } from 'vitest'
import { botItemQuestionLine } from './bot-item-ask'

describe('botItemQuestionLine', () => {
  it('skips a leading line that is only a Markdown mark', () => {
    expect(botItemQuestionLine('##\n\n**Merge** `__init__` now?')).toBe('Merge __init__ now?')
  })
})
