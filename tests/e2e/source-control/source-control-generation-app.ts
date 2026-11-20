import { test as base } from '../desktop/electron-fixtures/orca-app'

import { createSeededTestRepo } from '../workspaces/repository-fixtures/seeded-test-repo'
import { cleanupTestRepository } from '../global-teardown'

export const test = base.extend({
  seededRepoPath: async ({ registerPostElectronShutdownCleanup }, provideFixture) => {
    // Git indexes and remotes must not survive between generation scenarios.
    const repoPath = createSeededTestRepo({ publishPath: false })
    registerPostElectronShutdownCleanup(async () => cleanupTestRepository(repoPath))
    await provideFixture(repoPath)
  }
})
