import { describe, expect, it } from 'vitest'
import { getWorktreeGitHubIssueRepository } from './github-issue-repository'
import type { WorkspaceLinkedItem } from './types'

const item: WorkspaceLinkedItem = {
  provider: 'github',
  type: 'issue',
  number: 247,
  title: 'Fork issue',
  url: 'https://github.com/nisso-DSI/nsg-genai/issues/247'
}

describe('getWorktreeGitHubIssueRepository', () => {
  it('uses the linked URL rather than the project or current selector', () => {
    expect(getWorktreeGitHubIssueRepository({ linkedIssue: 247, linkedWorkItem: item })).toEqual({
      owner: 'nisso-DSI',
      repo: 'nsg-genai',
      host: 'github.com'
    })
  })

  it('keeps an Enterprise host and port', () => {
    expect(
      getWorktreeGitHubIssueRepository({
        linkedIssue: 247,
        linkedWorkItem: { ...item, url: 'https://git.example.com:8443/team/repo/issues/247' }
      })
    ).toEqual({ owner: 'team', repo: 'repo', host: 'git.example.com:8443' })
  })

  it.each([
    undefined,
    { ...item, provider: 'gitlab' as const },
    { ...item, type: 'pr' as const },
    { ...item, number: 248 },
    { ...item, url: 'https://github.com/nisso-DSI/nsg-genai/issues/248' },
    { ...item, url: 'https://github.com/nisso-DSI/nsg-genai/pull/247' },
    { ...item, url: 'invalid' }
  ])('does not reinterpret missing or unrelated link metadata (%j)', (linkedWorkItem) => {
    expect(getWorktreeGitHubIssueRepository({ linkedIssue: 247, linkedWorkItem })).toBeUndefined()
  })
})
