import { describe, expect, it } from 'vitest'
import { rankExistingCheckouts } from './existing-checkout-suggestions'

describe('rankExistingCheckouts', () => {
  it('ranks same-remote checkouts above same-name folders across ssh/https spellings', () => {
    expect(
      rankExistingCheckouts({
        projectName: 'Widget',
        remoteUrl: 'git@github.com:Acme/widget.git',
        candidates: [
          {
            path: '/home/u/src/widget',
            folderName: 'widget',
            remoteUrls: ['https://github.com/other/widget']
          },
          {
            path: '/home/u/git/acme/renamed',
            folderName: 'renamed',
            remoteUrls: ['https://github.com/acme/widget']
          },
          {
            path: '/home/u/git/widget',
            folderName: 'widget',
            remoteUrls: ['https://GitHub.com/acme/Widget.git']
          },
          {
            path: '/home/u/git/unrelated',
            folderName: 'unrelated',
            remoteUrls: ['https://github.com/acme/other']
          }
        ]
      })
    ).toEqual([
      { path: '/home/u/git/widget', match: 'remote' },
      { path: '/home/u/git/acme/renamed', match: 'remote' },
      { path: '/home/u/src/widget', match: 'name' }
    ])
  })

  it('matches folder projects by name only and caps the list', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((root) => ({
      path: `/home/u/${root}/notes`,
      folderName: 'Notes',
      remoteUrls: []
    }))
    expect(rankExistingCheckouts({ projectName: 'notes', candidates }).map((s) => s.path)).toEqual([
      '/home/u/a/notes',
      '/home/u/b/notes',
      '/home/u/c/notes',
      '/home/u/d/notes',
      '/home/u/e/notes'
    ])
  })
})
