/**
 * Invariant: the documented hello-orca plugin stays inert before visible
 * consent, then its panel, worker command, and event subscription all work.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'

async function openPluginSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'plugins', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function openDemoPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.closeSettingsPage()
    if (!state.rightSidebarOpen) {
      state.toggleRightSidebar()
    }
  })
  const panelButton = page.getByRole('button', { name: 'Hello Orca', exact: true })
  await expect(panelButton).toBeVisible({ timeout: 15_000 })
  await panelButton.click()
  const frame = page.frameLocator('iframe[title="Hello Orca"]')
  await expect(frame.getByRole('heading', { name: 'Hello Orca 👋' })).toBeVisible()
  await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    /default-src 'none'/
  )
}

async function createWorktree(page: Page, name: string): Promise<string> {
  await page.waitForFunction(
    () => {
      const state = window.__store?.getState()
      return Boolean(state && Object.values(state.worktreesByRepo).flat().length > 0)
    },
    undefined,
    { timeout: 15_000 }
  )
  return page.evaluate(async (worktreeName) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const active =
      worktrees.find((worktree) => worktree.id === state.activeWorktreeId) ?? worktrees[0]
    if (!active) {
      throw new Error('active worktree was not found')
    }
    const result = await state.createWorktree(active.repoId, worktreeName)
    return result.worktree.id
  }, name)
}

test('runs hello-orca panel, command, and event behind visible consent', async ({ orcaPage }) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-hello-plugin-e2e-'))
  const pluginRoot = join(tempRoot, 'hello-orca')
  let createdWorktreeId: string | null = null
  await cp(join(process.cwd(), 'examples', 'plugins', 'hello-orca'), pluginRoot, {
    recursive: true
  })

  try {
    const installed = await orcaPage.evaluate(async (sourcePath) => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      const result = await window.api.plugins.install({ kind: 'local-path', path: sourcePath })
      if (!result.ok) {
        throw new Error(result.error)
      }
      const pending = (await window.api.plugins.refresh()).find(
        (entry) => entry.pluginKey === result.pluginKey
      )
      if (!pending) {
        throw new Error('installed plugin was not listed')
      }
      let blocked = false
      try {
        await window.api.plugins.invokeCommand({
          pluginKey: result.pluginKey,
          commandId: 'hello-ping',
          args: { source: 'before-consent' }
        })
      } catch {
        blocked = true
      }
      return { pluginKey: result.pluginKey, status: pending.status, blocked }
    }, pluginRoot)

    expect(installed.status).toBe('pending')
    expect(installed.blocked).toBe(true)

    await openPluginSettings(orcaPage)
    const row = orcaPage.locator(`[data-plugin-key="${installed.pluginKey}"]`)
    await expect(row).toContainText('Needs review')
    await row.getByRole('button', { name: 'Review permissions' }).click()
    const consent = orcaPage.getByRole('dialog', { name: 'Review permissions' })
    await expect(consent).toBeVisible()
    await expect(consent).toContainText(pluginRoot)
    await expect(consent).toContainText('full access to your files, network, and other processes')
    await expect(consent.getByRole('button', { name: 'Keep Disabled' })).toBeFocused()
    await consent.getByRole('button', { name: 'Enable plugin' }).click()
    await expect(consent).toBeHidden()
    await expect(row).toContainText('Enabled')

    const commandResults = await orcaPage.evaluate(async (pluginKey) => {
      const first = await window.api.plugins.invokeCommand({
        pluginKey,
        commandId: 'hello-ping',
        args: { source: 'e2e' }
      })
      const second = await window.api.plugins.invokeCommand({
        pluginKey,
        commandId: 'hello-ping',
        args: { source: 'e2e' }
      })
      return { first, second }
    }, installed.pluginKey)
    expect(commandResults.first).toEqual({ pong: true, count: 1, args: { source: 'e2e' } })
    expect(commandResults.second).toEqual({ pong: true, count: 2, args: { source: 'e2e' } })

    await orcaPage.evaluate(async (sourcePath) => {
      const settings = await window.api.settings.set({ devPluginPaths: [sourcePath] })
      window.__store?.setState({ settings })
      await window.api.plugins.refresh()
    }, pluginRoot)

    await openDemoPanel(orcaPage)

    const panelPath = join(pluginRoot, 'panel.html')
    const panelHtml = await readFile(panelPath, 'utf8')
    await writeFile(panelPath, panelHtml.replace('Hello Orca 👋', 'Hello Orca reloaded'))
    await expect(
      orcaPage.frameLocator('iframe[title="Hello Orca"]').getByRole('heading', {
        name: 'Hello Orca reloaded'
      })
    ).toBeVisible({ timeout: 15_000 })

    createdWorktreeId = await createWorktree(orcaPage, `plugin-event-${Date.now()}`)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            async ({ pluginKey, worktreeId }) =>
              (await window.api.plugins.getLogs({ pluginKey })).some(
                (entry) =>
                  entry.line.includes('worktree created:') && entry.line.includes(worktreeId)
              ),
            { pluginKey: installed.pluginKey, worktreeId: createdWorktreeId! }
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
  } finally {
    if (createdWorktreeId) {
      await orcaPage
        .evaluate(async (worktreeId) => {
          await window.__store?.getState().removeWorktree(worktreeId, true)
        }, createdWorktreeId)
        .catch(() => undefined)
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})
