import { describe, expect, it } from 'vitest'
import { clipAtWord } from './surrogate-safe-text-slice'

describe('clipAtWord', () => {
  it('keeps text that fits, on one line', () => {
    expect(clipAtWord('  close  finished\nbot chats ', 80)).toBe('close finished bot chats')
  })

  it('cuts at the last word that fits, with an ellipsis within the limit', () => {
    const text = 'D1: close bot chats whose work is all done/canceled (item 1077)'
    const clipped = clipAtWord(text, 40)
    expect(clipped).toBe('D1: close bot chats whose work is all…')
    expect(clipped.length).toBeLessThanOrEqual(40)
  })

  it('drops punctuation left before the ellipsis', () => {
    expect(clipAtWord('Urgent M4Air RAM: release your completed workers', 18)).toBe(
      'Urgent M4Air RAM…'
    )
  })

  it('cuts inside one long word rather than leaving almost nothing', () => {
    expect(clipAtWord('a supercalifragilisticexpialidocious', 12)).toBe('a supercali…')
  })

  it('never splits an emoji', () => {
    const clipped = clipAtWord('abcdefghi😀xyz', 11)
    expect(clipped).toBe('abcdefghi…')
  })
})
