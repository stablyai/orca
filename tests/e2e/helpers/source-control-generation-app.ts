import { test as base, expect } from './orca-app'
import { createSeededTestRepo } from './seeded-test-repo'
import { cleanupTestRepository } from '../global-teardown'

export { expect }

export const test = base.extend({
  seededRepoPath: async ({ registerPostElectronShutdownCleanup }, provideFixture) => {
    // Git indexes and remotes must not survive between generation scenarios.
    const repoPath = createSeededTestRepo({ publishPath: false })
    registerPostElectronShutdownCleanup(async () => cleanupTestRepository(repoPath))
    await provideFixture(repoPath)
  }
})
