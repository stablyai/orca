import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import { createRemoteTerminalTab } from './helpers/docker-ssh-relay-terminal-tabs'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { dropDockerSshRelayTransport } from './helpers/docker-ssh-relay-faults'
import { createRestartSession, readRestartRendererState } from './helpers/orca-restart'
import { readPersistedProfileState } from './helpers/persisted-profile-state'
import { toSshExecutionHostId } from '../../src/shared/execution-host'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

test.use({ seedTestRepo: false })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function readWorkspace(page: Page, worktreeId: string): Promise<string | null> {
  return readRestartRendererState(() =>
    page.evaluate((id) => {
      const state = window.__store?.getState()
      if (!state) {
        return null
      }
      return JSON.stringify({
        tabs: (state.tabsByWorktree[id] ?? []).length,
        files: state.openFiles.filter((file) => file.worktreeId === id).map((f) => f.relativePath)
      })
    }, worktreeId)
  ).catch(() => null)
}

function readPersistedSshOpenFiles(
  userDataDir: string,
  targetId: string,
  worktreeId: string
): unknown[] {
  const sessions = readPersistedProfileState(userDataDir).workspaceSessionsByHostId
  const session = isRecord(sessions) ? sessions[toSshExecutionHostId(targetId)] : undefined
  const files =
    isRecord(session) && isRecord(session.openFilesByWorktree)
      ? session.openFilesByWorktree[worktreeId]
      : undefined
  return Array.isArray(files)
    ? files.map((file) => (isRecord(file) ? file.relativePath : undefined))
    : []
}

type PrivateInvokeHandlers = {
  _invokeHandlers?: Map<string, (event: unknown, args: unknown) => unknown>
}

/** Main's SSH state, read without a renderer; it reports `connected` only once the relay's
 *  reattach has finished (the relay override holds `reconnecting` until then). */
function readMainSshState(app: ElectronApplication, targetId: string): Promise<unknown> {
  return app.evaluate(({ ipcMain }, id) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only read of Electron's private invoke-handler map; the handler is called only if present.
    const { _invokeHandlers: handlers } = ipcMain as unknown as PrivateInvokeHandlers
    return handlers?.get('ssh:getState')?.({}, { targetId: id })
  }, targetId)
}

/**
 * A relay reattach used to bind the SSH pane into the `local` partition. With a window open the
 * renderer's next save erased that copy within a second, but a reattach with no window (macOS
 * keeps Orca running after its window closes) left it on disk. Startup then kept the `local` copy
 * and skipped the SSH partition's rows for that workspace, so its open editor tabs were missing
 * and its agent-resume records were dropped (STA-9544).
 */
test.describe('SSH relay reattach home partition', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('a reattach with no window open keeps the SSH workspace on the next launch', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns every Electron launch.
  {}, testInfo) => {
    test.setTimeout(600_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const first = await restart.launch()
      app = first.app
      let page = first.page
      await waitForSessionReady(page)
      const remote = await connectDockerSshRelayTarget(page, target)
      const { targetId, worktreeId } = remote
      await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(worktreeId)
      await waitForActiveTerminalManager(page, 60_000)
      await waitForActivePanePtyId(page, 60_000)
      await createRemoteTerminalTab(page, worktreeId)
      await page.evaluate(
        ({ worktreeId, filePath }) => {
          window.__store!.getState().openFile({
            filePath,
            relativePath: 'README.md',
            worktreeId,
            language: 'markdown',
            mode: 'edit'
          })
        },
        { worktreeId, filePath: `${DOCKER_SSH_RELAY_REMOTE_REPO_PATH}/README.md` }
      )
      const expected = JSON.stringify({ tabs: 2, files: ['README.md'] })
      await expect.poll(() => readWorkspace(page, worktreeId)).toBe(expected)
      await expect
        .poll(() => readPersistedSshOpenFiles(restart.userDataDir, targetId, worktreeId))
        .toEqual(['README.md'])
      const before = await readMainSshState(first.app, targetId)
      expect(before).toMatchObject({
        status: 'connected',
        connectionGeneration: expect.any(Number)
      })

      await app.evaluate(({ app: electronApp, BrowserWindow }) => {
        // Linux/Windows quit when the last window closes; keep running as macOS does.
        electronApp.removeAllListeners('window-all-closed')
        electronApp.on('window-all-closed', () => {})
        for (const window of BrowserWindow.getAllWindows()) {
          window.close()
        }
      })
      expect(dropDockerSshRelayTransport(target)).toBeGreaterThan(0)
      // Main reconnects on its own and reattaches both panes; no window is left to save over it.
      await expect
        .poll(
          async () => {
            const after = await readMainSshState(first.app, targetId)
            return (
              isRecord(after) &&
              isRecord(before) &&
              after.status === 'connected' &&
              (after.providerEpoch !== before.providerEpoch ||
                after.connectionGeneration !== before.connectionGeneration)
            )
          },
          { timeout: 120_000 }
        )
        .toBe(true)
      await restart.close(app)
      app = null
      const local = readPersistedProfileState(restart.userDataDir).workspaceSession
      const localTabs =
        isRecord(local) && isRecord(local.tabsByWorktree) ? local.tabsByWorktree : {}
      expect.soft(localTabs[worktreeId] ?? [], 'SSH tabs in `local`').toEqual([])

      const second = await restart.launch()
      app = second.app
      page = second.page
      await expect
        .poll(() => readWorkspace(page, worktreeId), { timeout: 60_000, intervals: [500] })
        .toBe(expected)
    } finally {
      if (app) {
        await restart.close(app)
      }
      await restart.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
