import { resolve } from 'node:path'
import { it, vi } from 'vitest'
import { testState } from '../../src/main/persistence-test-harness'
import { verifyLiveCatalogMigration } from '../../src/main/ssh/orcad-live-catalog-acceptance'
import { createLiveCatalogDockerFixture } from './helpers/orcad-live-catalog-docker-fixture'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

it.skipIf(process.env.ORCA_REVIEW_ORCAD_SSH_LIFECYCLE !== '1').each([
  { lostPublication: 0, restartBeforeRetry: false, disconnectAfterMigration: false },
  { lostPublication: 2, restartBeforeRetry: true, disconnectAfterMigration: false },
  { lostPublication: 0, restartBeforeRetry: false, disconnectAfterMigration: true }
])(
  'migrates a no-Node SSH folder/worktree cohort, lostPublication=$lostPublication, restartBeforeRetry=$restartBeforeRetry, disconnectAfterMigration=$disconnectAfterMigration',
  async ({ lostPublication, restartBeforeRetry, disconnectAfterMigration }) => {
    const target = process.env.ORCA_REVIEW_ORCAD_TARGET
    if (target !== 'linux-arm64-glibc' && target !== 'linux-x64-glibc') {
      throw new Error('fixture_linux_glibc_target_required')
    }
    const host = await createLiveCatalogDockerFixture({
      disconnectAfterMigration,
      relayArtifactDir: resolve('out', 'relay', target.replace('-glibc', '')),
      orcadArtifactDir: resolve(
        process.env.ORCA_REVIEW_ORCAD_ARTIFACT_DIR ?? 'out/orcad-ssh-lifecycle'
      )
    })
    await verifyLiveCatalogMigration({
      host,
      lostPublication,
      restartBeforeRetry,
      unsupportedPeer: 'none'
    })
  },
  420_000
)
