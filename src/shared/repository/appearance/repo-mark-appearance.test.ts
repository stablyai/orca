import { describe, expect, it } from 'vitest'
import { repoMarkKey, resolveRepoMarkAppearances } from './repo-mark-appearance'

function repo(id: string, addedAt: number, extra: Record<string, unknown> = {}) {
  return { id, displayName: id, addedAt, badgeColor: '#737373', repoIcon: null, ...extra }
}

const markOf = (
  marks: ReturnType<typeof resolveRepoMarkAppearances>,
  id: string,
  addedAt: number
) => marks.get(repoMarkKey(repo(id, addedAt)))

describe('resolveRepoMarkAppearances', () => {
  it('gives projects without an icon distinct letters and real colors, oldest first', () => {
    const marks = resolveRepoMarkAppearances([
      repo('orca-internal', 2),
      repo('orca', 1),
      repo('ops', 3)
    ])
    expect(markOf(marks, 'orca', 1)).toEqual({
      icon: { type: 'letters', text: 'OR' },
      color: '#ef4444'
    })
    expect(markOf(marks, 'orca-internal', 2)).toEqual({
      icon: { type: 'letters', text: 'OI' },
      color: '#f97316'
    })
    expect(markOf(marks, 'ops', 3)).toEqual({
      icon: { type: 'letters', text: 'OP' },
      color: '#eab308'
    })
  })

  it('keeps default letters off letters a project chose explicitly', () => {
    const marks = resolveRepoMarkAppearances([
      repo('orca', 1),
      repo('other', 2, { repoIcon: { type: 'letters', text: 'OR' } })
    ])
    expect(markOf(marks, 'orca', 1)?.icon).toEqual({ type: 'letters', text: 'OC' })
  })

  it('skips colors a sibling picked explicitly, and leaves images out of color groups', () => {
    const avatar = { type: 'image', src: 'https://github.com/acme.png', source: 'github' }
    const marks = resolveRepoMarkAppearances([
      repo('a', 1),
      repo('b', 2, { badgeColor: '#ef4444' }),
      repo('c', 3),
      repo('d', 4, { repoIcon: avatar })
    ])
    expect(markOf(marks, 'a', 1)?.color).toBe('#f97316')
    expect(markOf(marks, 'c', 3)?.color).toBe('#eab308')
    expect(markOf(marks, 'd', 4)).toEqual({ icon: avatar, color: '#737373' })
  })

  it('never auto-colors icons grey', () => {
    const rocket = { type: 'lucide', name: 'Rocket' }
    const marks = resolveRepoMarkAppearances([repo('b', 2, { repoIcon: rocket })])
    expect(markOf(marks, 'b', 2)).toEqual({ icon: rocket, color: '#ef4444' })
  })
})
