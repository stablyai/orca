import { describe, expect, it } from 'vitest'
import { planSourceControlCompareBaseRefWrite } from './compare-base-ref-write'

describe('planSourceControlCompareBaseRefWrite', () => {
  it('pins only the active worktree when selecting a compare ref', () => {
    expect(
      planSourceControlCompareBaseRefWrite({
        action: 'select',
        worktreeId: 'repo::/wt',
        ref: 'origin/dev'
      })
    ).toEqual({
      worktreeUpdate: { worktreeId: 'repo::/wt', baseRef: 'origin/dev' }
    })
  })

  it('does not write the shared repo pin when the worktree id is missing', () => {
    expect(
      planSourceControlCompareBaseRefWrite({
        action: 'select',
        worktreeId: null,
        ref: 'origin/dev'
      })
    ).toEqual({})
  })

  it('clears only the worktree pin when reverting to the project default', () => {
    expect(
      planSourceControlCompareBaseRefWrite({
        action: 'use-project-default',
        worktreeId: 'repo::/wt'
      })
    ).toEqual({
      worktreeUpdate: { worktreeId: 'repo::/wt', baseRef: undefined }
    })
  })

  it('writes the repo pin only for the explicit project-default action', () => {
    expect(
      planSourceControlCompareBaseRefWrite({
        action: 'set-project-default',
        repoId: 'repo-1',
        ref: 'origin/stage'
      })
    ).toEqual({
      repoUpdate: { repoId: 'repo-1', worktreeBaseRef: 'origin/stage' }
    })
  })

  it('ignores set-project-default without a ref', () => {
    expect(
      planSourceControlCompareBaseRefWrite({
        action: 'set-project-default',
        repoId: 'repo-1',
        ref: '  '
      })
    ).toEqual({})
  })

  it('clears only the repo pin when dropping the project default', () => {
    expect(
      planSourceControlCompareBaseRefWrite({ action: 'clear-project-default', repoId: 'repo' })
    ).toEqual({ repoUpdate: { repoId: 'repo', worktreeBaseRef: undefined } })
  })
})
