import { describe, expect, it } from 'vitest'
import { soulDescription, starterSoul } from './bot-soul'

describe('soulDescription', () => {
  it('is the first paragraph under the title, on one line', () => {
    expect(
      soulDescription(
        '# Reviewer\n\nReviews pull requests\nfor the desktop app.\n\n## Rules\n\nNever merge.\n'
      )
    ).toBe('Reviews pull requests for the desktop app.')
  })

  it('is hidden while the soul is still the starter line, or has no paragraph', () => {
    // A renamed bot's SOUL.md still has the starter line with its first name.
    expect(soulDescription(starterSoul('Ranger').replace('# Ranger', '# Scout'))).toBeNull()
    expect(soulDescription('# Ranger\n\n## Rules\n')).toBeNull()
    expect(soulDescription('')).toBeNull()
  })
})

describe('a set-up SOUL.md', () => {
  it('describes such a file by its first paragraph that isn’t a heading', () => {
    expect(soulDescription('# Ranger\n\n## Purpose\n\nTriages incidents.\n')).toBe(
      'Triages incidents.'
    )
  })
})
