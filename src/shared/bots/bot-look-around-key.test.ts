import { describe, expect, it } from 'vitest'
import { suggestionKey } from './bot-look-around'

describe('suggestion keys', () => {
  it('name the thing a link points at, however the link is written', () => {
    const pr = suggestionKey({ title: 'a', link: 'https://github.com/stablyai/orca/pull/12' })
    for (const link of [
      'https://GitHub.com/StablyAI/Orca/pull/12/files#r99',
      'https://github.com/stablyai/orca/pull/12?w=1',
      'https://www.github.com/stablyai/orca/pull/12/'
    ]) {
      expect(suggestionKey({ title: 'b', link })).toBe(pr)
    }
    expect(
      suggestionKey({ title: 'a', link: 'https://linear.app/globex/issue/ENG-1/old-slug' })
    ).toBe(suggestionKey({ title: 'b', link: 'https://linear.app/globex/issue/eng-1/new-slug' }))
  })

  it('tell apart different things with the same title, and fall back to the title', () => {
    expect(suggestionKey({ title: 'Review it', link: 'https://github.com/o/r/pull/1' })).not.toBe(
      suggestionKey({ title: 'Review it', link: 'https://github.com/o/r/pull/2' })
    )
    expect(suggestionKey({ title: '  Fix  CI ' })).toBe(suggestionKey({ title: 'fix ci' }))
  })
})
