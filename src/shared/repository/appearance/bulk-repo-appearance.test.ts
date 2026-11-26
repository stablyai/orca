import { describe, expect, it } from 'vitest'
import {
  canShareRepoIconAcrossProjects,
  planBulkRepoAppearanceUpdates
} from './bulk-repo-appearance'

describe('planBulkRepoAppearanceUpdates', () => {
  it('plans updates for differing visible projects across hosts and skips hidden or matching ones', () => {
    const folder = { type: 'lucide', name: 'Folder' } as const
    const source = { id: 'cityu', badgeColor: '#737373', repoIcon: folder }
    const plan = planBulkRepoAppearanceUpdates(source, [
      source,
      { id: 'rp', badgeColor: '#ef4444', repoIcon: null },
      { id: 'remote', badgeColor: '#737373', repoIcon: null, connectionId: 'devbox' },
      { id: 'same', badgeColor: '#737373', repoIcon: folder },
      { id: 'hidden', badgeColor: '#14b8a6', repoIcon: null, hiddenAt: 100 }
    ])

    expect(plan).toEqual([
      {
        repoId: 'rp',
        hostId: 'local',
        updates: { repoIcon: folder, badgeColor: '#737373' },
        previous: { repoIcon: null, badgeColor: '#ef4444' }
      },
      {
        repoId: 'remote',
        hostId: 'ssh:devbox',
        updates: { repoIcon: folder, badgeColor: '#737373' },
        previous: { repoIcon: null, badgeColor: '#737373' }
      }
    ])
  })

  it('refuses per-project monograms and repository images', () => {
    expect(canShareRepoIconAcrossProjects({ type: 'letters', text: 'CU' })).toBe(false)
    expect(
      canShareRepoIconAcrossProjects({
        type: 'image',
        src: 'https://github.com/stablyai.png?size=64',
        source: 'github'
      })
    ).toBe(false)
    expect(
      planBulkRepoAppearanceUpdates(
        { id: 'a', badgeColor: '#737373', repoIcon: { type: 'letters', text: 'CU' } },
        [
          { id: 'a', badgeColor: '#737373', repoIcon: { type: 'letters', text: 'CU' } },
          { id: 'b', badgeColor: '#737373', repoIcon: null }
        ]
      )
    ).toEqual([])
  })
})
