import { describe, expect, it } from 'vitest'
import { buildWorkspaceReviewFacts, readWorkspaceReviewFact } from './workspace-review-facts'

const repo = { id: 'repo-1', path: '/r', connectionId: null, executionHostId: null }
const row = { id: 'repo-1::/r/a', repoId: 'repo-1', branch: 'refs/heads/a', linkedPR: null }
const pr = (state: string, number = 7) => ({ data: { number, state } })

describe('readWorkspaceReviewFact', () => {
  it('prefers the repo-scoped entry over legacy ones', () => {
    const cache = { 'repo-1::a': pr('merged'), '/r::a': pr('closed') }
    expect(readWorkspaceReviewFact(row, repo, cache)).toEqual({
      provider: 'github',
      reviewState: 'merged'
    })
    expect(readWorkspaceReviewFact(row, repo, { '/r::a': pr('closed') })?.reviewState).toBe(
      'closed'
    )
  })

  it('reads only host-scoped entries for SSH and paired-server repos', () => {
    const cache = { 'repo-1::a': pr('merged'), 'ssh:c1::repo-1::a': pr('open') }
    expect(readWorkspaceReviewFact(row, { ...repo, connectionId: 'c1' }, cache)?.reviewState).toBe(
      'open'
    )
    expect(
      readWorkspaceReviewFact(row, { ...repo, executionHostId: 'runtime:env' }, cache)
    ).toBeNull()
  })

  it('drops a PR the user unlinked, and rows with no repo, branch or PR', () => {
    const cache = { 'repo-1::a': pr('open') }
    expect(readWorkspaceReviewFact({ ...row, suppressedGitHubPR: 7 }, repo, cache)).toBeNull()
    expect(
      readWorkspaceReviewFact({ ...row, linkedPR: 7, suppressedGitHubPR: 7 }, repo, cache)
    ).not.toBeNull()
    expect(readWorkspaceReviewFact(row, undefined, cache)).toBeNull()
    expect(readWorkspaceReviewFact({ ...row, branch: '' }, repo, cache)).toBeNull()
    expect(readWorkspaceReviewFact(row, repo, { 'repo-1::a': { data: null } })).toBeNull()
  })
})

it('lists only rows with a PR, under the key the workspaces domain lists them at', () => {
  const other = { ...row, id: 'repo-1::/r/b', branch: 'b' }
  expect(buildWorkspaceReviewFacts([row, other], [repo], { 'repo-1::a': pr('open') })).toEqual({
    [`|${row.id}`]: { provider: 'github', reviewState: 'open' }
  })
})

it('reads each host’s copy of a same-id workspace with its own repo, under its own key', () => {
  const sshRepo = { ...repo, connectionId: 'box' }
  const local = { ...row, hostId: 'local' as const }
  const remote = { ...row, hostId: 'ssh:box' as const }
  const cache = { 'repo-1::a': pr('merged'), 'ssh:box::repo-1::a': pr('open') }
  expect(buildWorkspaceReviewFacts([local, remote], [repo, sshRepo], cache)).toEqual({
    [`local|${row.id}`]: { provider: 'github', reviewState: 'merged' },
    [`ssh:box|${row.id}`]: { provider: 'github', reviewState: 'open' }
  })
})
