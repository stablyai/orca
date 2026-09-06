import { test as base, expect } from './orca-app'
import { createSeededTestRepo } from './seeded-test-repo'
import { cleanupTestRepository } from '../global-teardown'

export { expect }

export const test = base.extend({
  testRepoPath: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires destructured fixture arguments.
    async ({}, provideFixture) => {
      // Generation must not fetch external remotes installed by unrelated specs.
      const repoPath = createSeededTestRepo({ publishPath: false })
      try {
        await provideFixture(repoPath)
      } finally {
        cleanupTestRepository(repoPath)
      }
    },
    { scope: 'worker' }
  ]
})
