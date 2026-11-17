import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import { applyDetectedWorktreeUpdates } from './detected-worktree-meta'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'

const TARGET_ID = 'repo-target::/work/batfish-2'

function row(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: id.slice(id.indexOf('::') + 2),
    head: 'aaa',
    branch: 'refs/heads/me/triage-assigned-issues-prs',
    isBare: false,
    isMainWorktree: false,
    displayName: 'batfish-2',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function detectedMap(otherRepos: number): {
  map: AppState['detectedWorktreesByRepo']
  otherReads: () => number
} {
  let reads = 0
  const map: AppState['detectedWorktreesByRepo'] = {
    'repo-target': makeDetectedResult('repo-target', [row(TARGET_ID, 'repo-target')])
  }
  for (let i = 0; i < otherRepos; i++) {
    const repoId = `repo-${i}`
    const result = makeDetectedResult(repoId, [row(`${repoId}::/work/w${i}`, repoId)])
    const bucket: DetectedWorktreeListResult = { ...result }
    Object.defineProperty(bucket, 'worktrees', {
      enumerable: true,
      get: () => {
        reads++
        return result.worktrees
      }
    })
    map[repoId] = bucket
  }
  return { map, otherReads: () => reads }
}

describe('applyDetectedWorktreeUpdates', () => {
  it.each([10, 100])('reads only the named repo bucket with %i other repos', (otherRepos) => {
    const { map, otherReads } = detectedMap(otherRepos)
    const pin = { displayName: 'Triage assigned issues prs', displayNameIsPinned: true }

    const next = applyDetectedWorktreeUpdates(map, TARGET_ID, pin)

    expect(otherReads()).toBe(0)
    expect(next['repo-target'].worktrees[0]).toMatchObject({
      displayName: 'Triage assigned issues prs',
      displayNameMode: 'fixed'
    })
    expect(applyDetectedWorktreeUpdates(next, TARGET_ID, pin)).toBe(next)
    expect(otherReads()).toBe(0)
  })
})
