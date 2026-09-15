import { mkdirSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { openWorkspaceWindow } from './helpers/workspace-window'
import { worktreeRowSurface } from './worktree-row-locators'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'

test('new native windows inherit configured hosts and close only their own remote views', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const sessions = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const first = state.tabsByWorktree[worktreeId]![0]!
    const second = state.createTab(worktreeId)
    return { worktreeId, first: first.id, second: second.id }
  })
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'Inherited host'
  )
  try {
    const localPath = testInfo.outputPath('local-folder')
    mkdirSync(localPath, { recursive: true })
    const localRepo = await client.page.evaluate(async (path) => {
      const result = await window.api.repos.add({ path, kind: 'folder' })
      if (!('repo' in result)) {
        throw new Error('Local folder was not added')
      }
      await window.__store!.getState().fetchReposForAllHosts()
      return result.repo.id
    }, localPath)
    const primaryFirst = client.page.locator(
      `[data-tab-id^="${toWebTerminalSurfaceTabId(sessions.first)}"]`
    )
    await worktreeRowSurface(client.page, sessions.worktreeId).click()
    await primaryFirst.click()
    const secondary = await openWorkspaceWindow(client.app)
    const errors: string[] = []
    secondary.on('pageerror', (error) => errors.push(error.message))
    const catalog = await secondary.evaluate(() => window.api.runtimeEnvironments.list())
    expect(catalog.some((entry) => entry.id === client.environmentId)).toBe(true)
    expect(catalog.length).toBeGreaterThan(1)
    await expect
      .poll(() =>
        secondary.evaluate(
          (id) => window.__store!.getState().repos.some((repo) => repo.id === id),
          localRepo
        )
      )
      .toBe(true)
    await worktreeRowSurface(secondary, sessions.worktreeId).click()
    const secondarySecond = secondary.locator(
      `[data-tab-id^="${toWebTerminalSurfaceTabId(sessions.second)}"]`
    )
    await secondarySecond.click()
    await expect(primaryFirst).toHaveAttribute('data-active', 'true')
    await expect(secondarySecond).toHaveAttribute('data-active', 'true')
    await secondarySecond.locator('[data-tab-close-button="true"]').click()
    const result = await secondary.evaluate(
      async ({ worktreeId, environmentId }) => {
        return window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'session.tabs.list',
          params: { worktree: `id:${worktreeId}` }
        })
      },
      {
        ...sessions,
        environmentId: client.environmentId
      }
    )
    expect(result.ok).toBe(true)
    await expect(secondarySecond).toHaveCount(0)
    await secondary.reload()
    await secondary.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
    const dismissSetup = secondary.getByRole('button', { name: 'Dismiss setup scripts' })
    await dismissSetup.click()
    await worktreeRowSurface(secondary, sessions.worktreeId).click()
    await expect(secondarySecond).toHaveCount(0)
    expect(
      await orcaPage.evaluate(
        ({ worktreeId, second }) =>
          window.__store!.getState().tabsByWorktree[worktreeId]!.some((tab) => tab.id === second),
        sessions
      )
    ).toBe(true)
    await expect(primaryFirst).toHaveAttribute('data-active', 'true')
    await secondary.evaluate(
      (selector) => window.api.runtimeEnvironments.disconnect({ selector }),
      client.environmentId
    )
    const disconnected = await secondary.evaluate(async (selector) => {
      const response = await window.api.runtimeEnvironments.call({ selector, method: 'repo.list' })
      return response.ok ? 'unexpected-success' : response.error.code
    }, client.environmentId)
    expect(disconnected).toBe('runtime_manually_disconnected')
    await secondary.evaluate(
      (selector) => window.api.runtimeEnvironments.connect({ selector }),
      client.environmentId
    )
    expect(
      await secondary.evaluate(
        (id) => window.__store!.getState().repos.some((repo) => repo.id === id),
        localRepo
      )
    ).toBe(true)
    await secondary.screenshot({ path: testInfo.outputPath('inherited-hosts.png') })
    expect(
      await client.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible())
      )
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await client.dispose()
  }
})
