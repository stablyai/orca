import type { ElectronApplication, Page } from '@stablyai/playwright-test'
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
import { createRestartSession } from './helpers/orca-restart'

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

function readRemoteProof(target: DockerSshRelayTarget, path: string): string | null {
  try {
    return execDockerSshRelayTargetCommand(target, `cat ${path}`)
  } catch {
    return null
  }
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
      // Six restored tabs overflow the strip at CI's window size and the restore pins it to the END,
      // so Terminal 1 starts outside the scroll viewport. Neither `click()` nor
      // `scrollIntoViewIfNeeded()` can reach it: both wait for the element to hold still, and the
      // strip keeps re-laying-out while the relay reconnects behind it — so they time out on an
      // element they can see but never settle on. This spec had never run in CI before this branch
      // routed it there, which is why that only shows up now.
      //
      // So the pointer is driven directly, and the whole attempt retried, which needs no element to
      // be stable — only to be somewhere at the moment it is pressed. Activation is deferred to
      // pointerup and suppressed past a drag threshold (tab-strip-pointer-activation.ts), so this
      // has to be a real down/up pair at one position; a synthetic click event would not select.
      // The retry asserts on the store, so a press that lands wrong is retried rather than believed.
      const tabStrip = orcaPage.locator('.terminal-tab-strip').first()
      const firstTab = orcaPage.getByRole('button', { name: /^Terminal 1 Close tab Terminal 1/ })
      await expect
        .poll(
          async () => {
            await tabStrip.evaluate((el) => {
              el.scrollLeft = 0
            })
            const box = await firstTab.boundingBox()
            if (!box) {
              return null
            }
            await orcaPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await orcaPage.mouse.down()
            await orcaPage.mouse.up()
            return orcaPage.evaluate(() => window.__store?.getState().activeTabId ?? null)
          },
          {
            timeout: 30_000,
            message: 'pressing the restored first tab never made it active'
          }
        )
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

  test('reclaims the authenticated PTY owner immediately after a full app restart', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both Electron launches.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const firstLaunch = await restart.launch()
      firstApp = firstLaunch.app
      await waitForSessionReady(firstLaunch.page)
      const remote = await connectDockerSshRelayTarget(firstLaunch.page, target)
      await expect
        .poll(() => waitForActiveWorktree(firstLaunch.page), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(firstLaunch.page, 60_000)
      const firstPtyId = await waitForActivePanePtyId(firstLaunch.page, 60_000)
      const token = `SSH_PROCESS_RESTART_${Date.now()}`
      const beforeProofPath = `/tmp/orca-ssh-restart-before-${Date.now()}`
      const afterProofPath = `/tmp/orca-ssh-restart-after-${Date.now()}`

      await focusActiveTerminalInput(firstLaunch.page)
      await firstLaunch.page.keyboard.type(
        `export ORCA_RESTART_TOKEN=${token}; cd /tmp; (while :; do sleep 60; done) & export ORCA_BG_PID=$!; printf '%s|%s|%s|%s\\n' "$$" "$ORCA_BG_PID" "$ORCA_RESTART_TOKEN" "$PWD" > ${beforeProofPath}`
      )
      await firstLaunch.page.keyboard.press('Enter')
      await expect.poll(() => readRemoteProof(target!, beforeProofPath)).not.toBeNull()
      const beforeProof = readRemoteProof(target, beforeProofPath)
      expect(beforeProof).toMatch(/^\d+\|\d+\|SSH_PROCESS_RESTART_\d+\|\/tmp$/)

      const beforeTabs = await readRemoteTerminalTabs(firstLaunch.page, remote.worktreeId)
      const restoredTabId = beforeTabs.find((tab) => tab.ptyId === firstPtyId)?.id
      if (!restoredTabId) {
        throw new Error('Active SSH terminal was not persisted in its worktree')
      }
      await firstLaunch.page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      await expect
        .poll(
          () =>
            firstLaunch.page.evaluate(
              async ({ targetId, worktreeId, tabId }) => {
                const persisted = await window.api.session.get()
                return (
                  persisted.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
                  persisted.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) === true
                )
              },
              { targetId: remote.targetId, worktreeId: remote.worktreeId, tabId: restoredTabId }
            ),
          { timeout: 10_000, message: 'SSH restart state was not persisted before quit' }
        )
        .toBe(true)

      await restart.close(firstApp)
      firstApp = null

      const secondLaunch = await restart.launch()
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(secondLaunch.page), { timeout: 60_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(secondLaunch.page, 60_000)
      expect(await waitForActivePanePtyId(secondLaunch.page, 60_000)).toBe(firstPtyId)
      await secondLaunch.page.evaluate((tabId) => {
        const manager = window.__paneManagers?.get(tabId)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
        if (!pane) {
          throw new Error('Restored SSH pane unavailable')
        }
        pane.terminal.options.screenReaderMode = true
        pane.terminal.refresh(0, pane.terminal.rows - 1)
      }, restoredTabId)

      const restoredMarker = `SSH_OWNER_RESTORED_${Date.now()}`
      await focusActiveTerminalInput(secondLaunch.page)
      await secondLaunch.page.keyboard.type(
        `printf '%s|%s|%s|%s\\n' "$$" "$ORCA_BG_PID" "$ORCA_RESTART_TOKEN" "$PWD" > ${afterProofPath}; printf '${restoredMarker}\\n'`
      )
      await secondLaunch.page.keyboard.press('Enter')
      await expect(
        secondLaunch.page.locator(
          `[data-terminal-tab-id=${JSON.stringify(restoredTabId)}] .xterm-accessibility-tree`
        )
      ).toContainText(restoredMarker, { timeout: 30_000 })
      await expect.poll(() => readRemoteProof(target!, afterProofPath)).toBe(beforeProof)
    } finally {
      if (secondApp) {
        await restart.close(secondApp)
      }
      if (firstApp) {
        await restart.close(firstApp)
      }
      await restart.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
