import { describe, expect, it } from 'vitest'
import { getWorktreeGitHubPRUrl } from './github-linked-item-url'

describe('getWorktreeGitHubPRUrl', () => {
  it('canonicalizes the saved link of the linked PR number', () => {
    const url = getWorktreeGitHubPRUrl(
      {
        linkedWorkItem: {
          provider: 'linear',
          type: 'issue',
          number: 588,
          title: 'Task',
          url: 'https://linear.app/team/issue/ENG-588'
        },
        linkedItems: [
          { provider: 'github', type: 'pr', number: 589, url: 'https://github.com/a/b/pull/589' },
          {
            provider: 'github',
            type: 'pr',
            number: 588,
            url: 'http://ghe.example.com:8443/upstream/widgets/pull/588/files?w=1#diff'
          }
        ]
      },
      588
    )

    expect(url).toBe('https://ghe.example.com:8443/upstream/widgets/pull/588')
  })
})
