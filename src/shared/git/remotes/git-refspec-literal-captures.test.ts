import { describe, expect, it } from 'vitest'
import { sourceRefsForTarget } from '../branches/git-branch-cleanup-fetch'
import { createGitReviewBranchSourceResolver } from './git-review-branch-source'

// Each is accepted by git check-ref-format; the dollar syntax belongs to the branch name.
const branches = ['topic/$&', 'topic/$`', "topic/$'", 'topic/$$', 'ordinary']

describe('literal Git refspec captures', () => {
  it('maps fetch sources without replacement-string expansion', () => {
    for (const branch of branches) {
      expect(
        sourceRefsForTarget(
          ['+refs/heads/*:refs/remotes/origin/*'],
          `refs/remotes/origin/${branch}`
        )
      ).toEqual([`refs/heads/${branch}`])
    }
  })

  it('maps review push destinations without replacement-string expansion', async () => {
    const resolve = await createGitReviewBranchSourceResolver(async (args) => ({
      stdout:
        args[0] === 'config'
          ? 'remote.origin.push\nrefs/heads/*:refs/heads/published/*\0'
          : 'origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n'
    }))

    for (const branch of branches) {
      expect(resolve(branch)).toMatchObject({ branchName: `published/${branch}` })
    }
  })
})
