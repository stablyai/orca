import type { Page } from '@stablyai/playwright-test'
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
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const TAB_COUNT = 6

test.use({ seedTestRepo: false })

async function createRemoteTerminalTab(page: Page, worktreeId: string): Promise<void> {
  const tabId = await page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    const tab = state.createTab(id, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().activeTabId ?? null), {
      timeout: 10_000
    })
    .toBe(tabId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
}

async function readRemoteTerminalTabs(
  page: Page,
  worktreeId: string
): Promise<{ id: string; ptyId: string | null }[]> {
  return page.evaluate(
    (id) =>
      (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => ({
        id: tab.id,
        ptyId: tab.ptyId
      })),
    worktreeId
  )
}

test.describe('SSH cold activation restore', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH restore uses POSIX SSH tooling.')

  test('eagerly remounts every restored remote terminal after renderer reload', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      while ((await readRemoteTerminalTabs(orcaPage, remote.worktreeId)).length < TAB_COUNT) {
        await createRemoteTerminalTab(orcaPage, remote.worktreeId)
      }
      const beforeReload = await readRemoteTerminalTabs(orcaPage, remote.worktreeId)
      expect(beforeReload).toHaveLength(TAB_COUNT)
      expect(new Set(beforeReload.map((tab) => tab.ptyId)).size).toBe(TAB_COUNT)
      expect(beforeReload.every((tab) => tab.ptyId !== null)).toBe(true)

      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ targetId, worktreePath }) => {
                const snapshot = await window.api.remoteWorkspace.get({ targetId })
                return (
                  snapshot?.session.tabsByWorktreePath[worktreePath]?.map((tab) => tab.id) ?? []
                )
              },
              {
                targetId: remote.targetId,
                worktreePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH
              }
            ),
          { timeout: 30_000, message: 'SSH tabs were not committed to the relay workspace' }
        )
        .toEqual(beforeReload.map((tab) => tab.id))

      await orcaPage.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async ({ targetId, worktreeId, expectedTabIds }) => {
                const session = await window.api.session.get()
                const persistedTabIds = new Set(
                  (session.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
                )
                return (
                  session.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
                  expectedTabIds.every((tabId) => persistedTabIds.has(tabId))
                )
              },
              {
                targetId: remote.targetId,
                worktreeId: remote.worktreeId,
                expectedTabIds: beforeReload.map((tab) => tab.id)
              }
            ),
          { timeout: 10_000, message: 'SSH tabs and active target were not persisted' }
        )
        .toBe(true)

      await orcaPage.reload()
      await waitForSessionReady(orcaPage, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status,
              remote.targetId
            ),
          { timeout: 60_000, message: 'renderer SSH state did not restore' }
        )
        .toBe('connected')

      const expectedTabIds = beforeReload.map((tab) => tab.id).sort()
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              (ids) => ids.filter((tabId) => window.__paneManagers?.has(tabId)).sort(),
              expectedTabIds
            ),
          { timeout: 60_000, message: 'not every restored SSH tab mounted a PaneManager' }
        )
        .toEqual(expectedTabIds)
      expect(
        await orcaPage.evaluate(
          (ids) =>
            ids.filter((tabId) => window.__terminalParkingDebug?.parkedTabIds().includes(tabId)),
          expectedTabIds
        )
      ).toEqual([])
      const afterReload = await readRemoteTerminalTabs(orcaPage, remote.worktreeId)
      expect(afterReload.map((tab) => tab.id).sort()).toEqual(expectedTabIds)
      expect(afterReload.map((tab) => tab.ptyId).sort()).toEqual(
        beforeReload.map((tab) => tab.ptyId).sort()
      )

      const firstTabId = beforeReload[0]?.id
      if (!firstTabId) {
        throw new Error('Restored SSH tabs disappeared')
      }
      await orcaPage.getByRole('button', { name: /^Terminal 1 Close tab Terminal 1/ }).click()
      await expect
        .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId ?? null), {
          timeout: 10_000
        })
        .toBe(firstTabId)
      await orcaPage.evaluate((tabId) => {
        const manager = window.__paneManagers?.get(tabId)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
        if (!pane) {
          throw new Error('Restored SSH pane unavailable')
        }
        pane.terminal.options.screenReaderMode = true
        pane.terminal.refresh(0, pane.terminal.rows - 1)
      }, firstTabId)

      const marker = `SSH_RESTORE_OK_${Date.now()}`
      const proofFile = '/tmp/orca-ssh-restore-proof'
      await focusActiveTerminalInput(orcaPage)
      await orcaPage.keyboard.type(`printf '${marker}' > ${proofFile} && printf '${marker}\\n'`)
      await orcaPage.keyboard.press('Enter')
      await expect(
        orcaPage.locator(
          `[data-terminal-tab-id=${JSON.stringify(firstTabId)}] .xterm-accessibility-tree`
        )
      ).toContainText(marker, { timeout: 30_000 })
      expect(execDockerSshRelayTargetCommand(target, `cat ${proofFile}`)).toBe(marker)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
