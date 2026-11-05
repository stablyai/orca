import { describe, expect, it } from 'vitest'
import { resolveWorkspaceIssueReferenceProps } from './workspace-issue-reference-target'

const githubItem = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 12,
  title: 'Old',
  url: 'https://github.com/acme/old/issues/12'
}

describe('resolveWorkspaceIssueReferenceProps', () => {
  it('uses the creation item when it matches the linked issue', () => {
    expect(
      resolveWorkspaceIssueReferenceProps(
        { linkedIssue: 12, linkedGitLabIssue: null, linkedWorkItem: githubItem },
        null
      )
    ).toEqual({ githubRepo: { owner: 'acme', repo: 'old', host: 'github.com' } })
  })

  it('ignores a GitHub creation item once the workspace links a GitLab issue', () => {
    const workspace = { linkedIssue: null, linkedGitLabIssue: 7, linkedWorkItem: githubItem }
    expect(resolveWorkspaceIssueReferenceProps(workspace, null)).toEqual({})
    expect(
      resolveWorkspaceIssueReferenceProps(workspace, {
        provider: 'gitlab',
        url: 'https://git.acme.dev/team/app/-/merge_requests/3'
      })
    ).toEqual({ gitlabProject: { host: 'git.acme.dev', path: 'team/app' } })
  })
})
