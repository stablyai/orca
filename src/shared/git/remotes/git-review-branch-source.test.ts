import { describe, expect, it } from 'vitest'
import { createGitReviewBranchSourceResolver } from './git-review-branch-source'

describe('createGitReviewBranchSourceResolver', () => {
  it('inserts a push wildcard capture containing $ sequences literally', async () => {
    const resolve = await createGitReviewBranchSourceResolver(async (args) => ({
      stdout:
        args[0] === 'config'
          ? 'remote.origin.push\nrefs/heads/*:refs/heads/published/*\0'
          : 'origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n'
    }))

    // git check-ref-format accepts this name; String.replace would expand $& to the matched '*'.
    expect(resolve('topic/$&')).toMatchObject({ branchName: 'published/topic/$&' })
  })
})
