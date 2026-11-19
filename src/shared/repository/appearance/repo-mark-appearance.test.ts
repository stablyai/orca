import { describe, expect, it } from 'vitest'
import { repoMarkKey, resolveRepoMarkAppearances } from './repo-mark-appearance'

function repo(id: string, addedAt: number, extra: Record<string, unknown> = {}) {
  return { id, addedAt, badgeColor: '#737373', repoIcon: null, ...extra }
}

describe('resolveRepoMarkAppearances', () => {
  it('gives default-folder projects distinct colors, oldest keeping neutral', () => {
    const marks = resolveRepoMarkAppearances([repo('b', 2), repo('a', 1), repo('c', 3)])
    expect(marks.get(repoMarkKey(repo('a', 1)))).toEqual({ color: '#737373' })
    expect(marks.get(repoMarkKey(repo('b', 2)))).toEqual({ color: '#ef4444' })
    expect(marks.get(repoMarkKey(repo('c', 3)))).toEqual({ color: '#f97316' })
  })

  it('skips colors a sibling picked explicitly, and leaves images out of color groups', () => {
    const avatar = { type: 'image', src: 'https://github.com/acme.png', source: 'github' }
    const marks = resolveRepoMarkAppearances([
      repo('a', 1, { badgeColor: '#737373' }),
      repo('b', 2, { badgeColor: '#ef4444' }),
      repo('c', 3),
      repo('d', 4, { repoIcon: avatar })
    ])
    expect(marks.get(repoMarkKey(repo('c', 3)))).toEqual({ color: '#f97316' })
    expect(marks.get(repoMarkKey(repo('d', 4)))).toEqual({ color: '#737373' })
  })

  it('never auto-colors letters grey', () => {
    const letters = { type: 'letters', text: 'OI' }
    const marks = resolveRepoMarkAppearances([repo('a', 1, { repoIcon: letters })])
    expect(marks.get(repoMarkKey(repo('a', 1)))).toEqual({ color: '#ef4444' })
  })
})
