import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  createRemoteTerminalTab,
  readRemoteTerminalTabs
} from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { createRestartSession, readRestartRendererState } from './helpers/orca-restart'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const STALE_TAB_ID = 'stale-closed-tab'

test.use({ seedTestRepo: false })

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(parent: JsonRecord, key: string): JsonRecord {
  const value = parent[key]
  if (isRecord(value)) {
    return value
  }
  const created: JsonRecord = {}
  parent[key] = created
  return created
}

function sshPartition(state: JsonRecord, targetId: string): JsonRecord {
  return record(record(state, 'workspaceSessionsByHostId'), `ssh:${targetId}`)
}

async function readRestoredTabIds(page: Page, worktreeId: string): Promise<string[] | null> {
  return readRestartRendererState(async () =>
    (await readRemoteTerminalTabs(page, worktreeId)).map((tab) => tab.id).sort()
  ).catch(() => null)
}

/**
 * A `local` row for an SSH workspace is residue: builds before #19572 wrote it, and relay reattach
 * wrote it later (#25616). Startup used to keep that copy whenever it held a tab and skip the SSH
 * partition's own rows, so live tabs vanished, closed ones came back, and the workspace's
 * agent-resume records were dropped and then erased by the first save (#23390).
 */
test.describe('SSH workspace startup with a stray local copy', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('the SSH partition wins over a stray local copy at startup', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const first = await restart.launch()
      app = first.app
      const page = first.page
      await waitForSessionReady(page)
      const { worktreeId, targetId } = await connectDockerSshRelayTarget(page, target)
      await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(worktreeId)
      await waitForActiveTerminalManager(page, 60_000)
      await waitForActivePanePtyId(page, 60_000)
      await createRemoteTerminalTab(page, worktreeId)
      const liveTabIds = (await readRemoteTerminalTabs(page, worktreeId)).map((tab) => tab.id)
      expect(liveTabIds).toHaveLength(2)
      // Past the ~1s debounced save, so the SSH partition holds both tabs.
      await page.waitForTimeout(3_000)
      await restart.close(app)
      app = null

      const [olderTabId, newerTabId] = liveTabIds
      const resumePaneKey = mutateStoppedProfileState(restart.userDataDir, (state) => {
        const ssh = sshPartition(state, targetId)
        const layout = record(record(ssh, 'terminalLayoutsByTabId'), newerTabId)
        const [leafId] = Object.keys(record(layout, 'ptyIdsByLeafId'))
        if (!leafId) {
          throw new Error(`Expected a bound leaf for ${newerTabId}: ${JSON.stringify(layout)}`)
        }
        const paneKey = `${newerTabId}:${leafId}`
        const sshTabs = record(ssh, 'tabsByWorktree')[worktreeId]
        if (!Array.isArray(sshTabs) || sshTabs.length !== 2) {
          throw new Error(`Expected both tabs in ssh:${targetId}, got ${JSON.stringify(sshTabs)}`)
        }
        record(ssh, 'sleepingAgentSessionsByPaneKey')[paneKey] = {
          paneKey,
          tabId: newerTabId,
          worktreeId,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-resume-probe' },
          prompt: 'continue',
          state: 'done',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'worktree-sleep'
        }
        // The stray copy: the older tab under its creation title, plus a tab closed long ago.
        const olderRow = sshTabs.find((tab) => isRecord(tab) && tab.id === olderTabId)
        record(record(state, 'workspaceSession'), 'tabsByWorktree')[worktreeId] = [
          { ...olderRow, title: 'Terminal 18', customTitle: null },
          { ...olderRow, id: STALE_TAB_ID, ptyId: null, title: 'Terminal 3', customTitle: null }
        ]
        return paneKey
      })

      const second = await restart.launch()
      app = second.app
      await waitForSessionReady(second.page)
      await expect
        .poll(() => readRestoredTabIds(second.page, worktreeId), { timeout: 60_000 })
        .toEqual([...liveTabIds].sort())
      // Past the debounced save, which is what used to erase the SSH partition's resume record.
      await second.page.waitForTimeout(3_000)
      await restart.close(app)
      app = null

      const persisted = readPersistedProfileState(restart.userDataDir)
      expect(
        Object.keys(record(sshPartition(persisted, targetId), 'sleepingAgentSessionsByPaneKey')),
        'agent-resume record in the SSH partition'
      ).toContain(resumePaneKey)
      const localTabs = record(record(persisted, 'workspaceSession'), 'tabsByWorktree')
      expect(localTabs[worktreeId] ?? [], 'stray local copy after a save').toEqual([])
    } finally {
      if (app) {
        await restart.close(app)
      }
      await restart.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
