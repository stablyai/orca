import { describe, expect, it } from 'vitest'
import {
  beginStructuredOptionPick,
  createStructuredOptionPickBook,
  settleStructuredOptionPick,
  structuredOptionPickCommit
} from './structured-agent-session-option-pick-book'

describe('structured option pick commits', () => {
  it('commits only its own option when another option was picked since', () => {
    const book = createStructuredOptionPickBook()
    const model = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'effort', 'low', false)
    expect(structuredOptionPickCommit(book, model, { model: 'opus', effort: 'high' })).toEqual({
      model: 'opus'
    })
  })

  it('commits nothing once the same option was picked again', () => {
    const book = createStructuredOptionPickBook()
    const first = beginStructuredOptionPick(book, 'model', 'opus', false)
    beginStructuredOptionPick(book, 'model', 'sonnet', false)
    expect(structuredOptionPickCommit(book, first, undefined)).toBeNull()
    settleStructuredOptionPick(book, first)
    expect(book.pending).toEqual({ model: 'sonnet' })
  })
})
