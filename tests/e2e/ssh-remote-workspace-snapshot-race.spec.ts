import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import {
  installRemoteWorkspaceSnapshotRequestBarrier,
  readRemoteWorkspaceSnapshotRequestBarrier,
  releaseRemoteWorkspaceSnapshotRequestBarrier,
  restoreRemoteWorkspaceSnapshotRequestHandler
} from './helpers/remote-workspace-snapshot-request-barrier'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const SORTABLE_TAB = '[data-testid="sortable-tab"]'

test.use({ seedTestRepo: false })

async function remoteTabIds(page: Page, targetId: string): Promise<string[]> {
  return page.evaluate(
    async ({ targetId, worktreePath }) => {
      const snapshot = await window.api.remoteWorkspace.get({ targetId })
      return snapshot?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
    },
    { targetId, worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
  )
}

async function installMutationChurn(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const baselineTabIds = new Set(
      (store.getState().tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
    )
    const scope = window as typeof window & {
      __remoteWorkspaceRace?: { freshTabId: string | null; done: boolean; cleanup: () => void }
    }
    let interval: number | null = null
    let freshTabId: string | null = null
    const baselineActiveTabId = store.getState().activeTabId
    const stop = (): void => {
      if (interval !== null) {
        window.clearInterval(interval)
        interval = null
      }
      unsubscribe()
      if (scope.__remoteWorkspaceRace) {
        scope.__remoteWorkspaceRace.done = true
      }
    }
    const unsubscribe = store.subscribe((state) => {
      if (!freshTabId) {
        freshTabId =
          (state.tabsByWorktree[worktreeId] ?? []).find((tab) => !baselineTabIds.has(tab.id))?.id ??
          null
        if (freshTabId) {
          scope.__remoteWorkspaceRace!.freshTabId = freshTabId
          let selectFresh = false
          interval = window.setInterval(() => {
            selectFresh = !selectFresh
            store.setState({ activeTabId: selectFresh ? freshTabId : baselineActiveTabId })
          }, 25)
        }
      }
      const status = Object.values(state.remoteWorkspaceSyncStatusByTargetId).find(
        (entry) => entry.phase === 'synced' && entry.direction === 'pull'
      )
      if (freshTabId && status) {
        stop()
      }
    })
    scope.__remoteWorkspaceRace = { freshTabId: null, done: false, cleanup: stop }
  }, worktreeId)
}

async function readRaceState(page: Page): Promise<{ freshTabId: string | null; done: boolean }> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & {
        __remoteWorkspaceRace?: { freshTabId: string | null; done: boolean }
      }
    ).__remoteWorkspaceRace
    return { freshTabId: state?.freshTabId ?? null, done: state?.done ?? false }
  })
}

async function exerciseSnapshotRace(
  app: ElectronApplication,
  page: Page,
  testInfo: TestInfo,
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
): Promise<void> {
  test.setTimeout(240_000)
  let target: DockerSshRelayTarget | null = null
  let connectedTargetId: string | null = null
  try {
    target = startDockerSshRelayTarget(testInfo)
    registerPostElectronShutdownCleanup(async () => cleanupDockerSshRelayTarget(target))
    await waitForSessionReady(page)
    const remote = await connectDockerSshRelayTarget(page, target)
    connectedTargetId = remote.targetId
    await expect
      .poll(() => waitForActiveWorktree(page), { timeout: 30_000 })
      .toBe(remote.worktreeId)
    await waitForActiveTerminalManager(page, 60_000)
    const initialPtyId = await waitForActivePanePtyId(page, 60_000)
    const initialTabId = await page.evaluate(() => window.__store?.getState().activeTabId ?? null)
    expect(initialTabId).not.toBeNull()
    await expect
      .poll(() => remoteTabIds(page, remote.targetId), { timeout: 30_000 })
      .toContain(initialTabId!)

    await installRemoteWorkspaceSnapshotRequestBarrier(app, remote.targetId)
    await reconnectDockerSshRelayTarget(page, remote.targetId)
    await expect
      .poll(() => readRemoteWorkspaceSnapshotRequestBarrier(app), { timeout: 30_000 })
      .toMatchObject({ captured: true, released: false })

    await installMutationChurn(page, remote.worktreeId)
    await page.getByRole('button', { name: 'New tab' }).click()
    await page
      .getByRole('menuitem', { name: /New Terminal/i })
      .first()
      .click()
    await expect.poll(() => readRaceState(page)).toMatchObject({ freshTabId: expect.any(String) })
    const freshTabId = (await readRaceState(page)).freshTabId!
    await expect(page.locator(`${SORTABLE_TAB}[data-tab-id="${freshTabId}"]`)).toBeVisible()
    let freshPtyId: string | null = null
    await expect
      .poll(
        async () => {
          freshPtyId = await page.evaluate(
            (tabId) => window.__store?.getState().ptyIdsByTabId[tabId]?.[0] ?? null,
            freshTabId
          )
          return freshPtyId
        },
        { timeout: 60_000 }
      )
      .not.toBeNull()
    expect(freshPtyId).not.toBe(initialPtyId)

    await releaseRemoteWorkspaceSnapshotRequestBarrier(app)
    await expect.poll(() => readRaceState(page), { timeout: 30_000 }).toMatchObject({ done: true })
    await expect(page.locator(`${SORTABLE_TAB}[data-tab-id="${freshTabId}"]`)).toBeVisible()
    await expect
      .poll(
        () =>
          page.evaluate(
            (tabId) => ({
              tabPresent: Object.values(window.__store?.getState().tabsByWorktree ?? {})
                .flat()
                .some((tab) => tab.id === tabId),
              ptyIds: window.__store?.getState().ptyIdsByTabId[tabId] ?? []
            }),
            freshTabId
          ),
        { timeout: 30_000 }
      )
      .toEqual({ tabPresent: true, ptyIds: expect.arrayContaining([freshPtyId]) })
    await expect
      .poll(() => remoteTabIds(page, remote.targetId), { timeout: 30_000 })
      .toContain(freshTabId)

    await page.locator(`${SORTABLE_TAB}[data-tab-id="${freshTabId}"]`).click()
    const marker = `SSH_SNAPSHOT_RACE_${Date.now()}`
    const proofPath = `/tmp/orca-ssh-snapshot-race-${Date.now()}`
    await focusActiveTerminalInput(page)
    await page.keyboard.type(`printf '${marker}' > ${proofPath} && printf '${marker}\\n'`)
    await page.keyboard.press('Enter')
    await expect
      .poll(
        () =>
          page.evaluate((tabId) => {
            const terminal = window.__paneManagers?.get(tabId)?.getActivePane?.()?.terminal
            if (!terminal) {
              return ''
            }
            return Array.from({ length: terminal.rows }, (_, row) =>
              terminal.buffer.active.getLine(row)?.translateToString(true)
            ).join('\n')
          }, freshTabId),
        { timeout: 30_000 }
      )
      .toContain(marker)
    expect(execDockerSshRelayTargetCommand(target, `cat ${proofPath}`)).toBe(marker)
    await testInfo.attach('headed-or-headless-terminal-survival', {
      body: await page.screenshot(),
      contentType: 'image/png'
    })
  } finally {
    await page
      .evaluate(() => {
        ;(
          window as typeof window & { __remoteWorkspaceRace?: { cleanup: () => void } }
        ).__remoteWorkspaceRace?.cleanup()
      })
      .catch(() => {})
    await restoreRemoteWorkspaceSnapshotRequestHandler(app).catch(() => {})
    if (connectedTargetId) {
      await disconnectDockerSshRelayTarget(page, connectedTargetId).catch(() => {})
    }
    cleanupDockerSshRelayTarget(target)
    target = null
  }
}

test.describe('direct SSH remote workspace snapshot ordering', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH ordering uses POSIX SSH tooling.')

  test('keeps a post-request terminal and its exact PTY identity @headful', async ({
    electronApp,
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) =>
    exerciseSnapshotRace(electronApp, orcaPage, testInfo, registerPostElectronShutdownCleanup))

  test('keeps a post-request terminal and its exact PTY identity headless parity', async ({
    electronApp,
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) =>
    exerciseSnapshotRace(electronApp, orcaPage, testInfo, registerPostElectronShutdownCleanup))
})
