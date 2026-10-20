/**
 * Invariant: a plugin task source shows on the Tasks page only after visible
 * consent, lists and filters its items, and its Start action only prefills
 * Create workspace for the user to review; nothing is created on its own.
 * Its filters survive leaving the page, its declared settings are editable,
 * and a workspace linked to one of its tasks points both ways.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { removeWorktreeViaStore } from './helpers/dead-terminal'

async function enableFromPluginSettings(page: Page, pluginKey: string): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'plugins', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
  await page.getByRole('tab', { name: /^Installed/ }).click()
  const row = page.locator(`[data-plugin-key="${pluginKey}"]`)
  await row.getByRole('button', { name: 'Review & enable' }).click()
  const consent = page.getByRole('dialog', { name: 'Review permissions' })
  await expect(consent).toContainText('Add task lists to the Tasks page')
  await consent.getByRole('button', { name: 'Enable plugin' }).click()
  await expect(row).toContainText('Enabled')
}

async function installHelloTasks(page: Page, tempRoot: string): Promise<string> {
  const pluginRoot = join(tempRoot, 'hello-tasks')
  await cp(join(process.cwd(), 'examples', 'plugins', 'hello-tasks'), pluginRoot, {
    recursive: true
  })
  const pluginKey = await page.evaluate(async (sourcePath) => {
    const settings = await window.api.settings.set({ pluginSystemEnabled: true })
    window.__store?.setState({ settings })
    const result = await window.api.plugins.install({ kind: 'local-path', path: sourcePath })
    if (!result.ok) {
      throw new Error(result.error)
    }
    await window.api.plugins.refresh()
    return result.pluginKey
  }, pluginRoot)
  await enableFromPluginSettings(page, pluginKey)
  return pluginKey
}

async function openHelloTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.closeSettingsPage()
    state?.openTaskPage()
  })
  const sourceTab = page.getByRole('button', { name: 'Hello Tasks', exact: true })
  await expect(sourceTab).toBeVisible({ timeout: 15_000 })
  if ((await sourceTab.getAttribute('aria-pressed')) !== 'true') {
    await sourceTab.click()
  }
  await expect(sourceTab).toHaveAttribute('aria-pressed', 'true')
}

// Why: screenshots taken mid slide-in/out show half-drawn sheets and dialogs.
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null)))
  )
}

async function countWorktrees(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    return state ? Object.values(state.worktreesByRepo).flat().length : -1
  })
}

async function selectStatus(page: Page, label: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Status' }).click()
  await page.getByRole('option', { name: label }).click()
}

test('lists plugin tasks and prefills Create workspace from a start recipe', async ({
  orcaPage
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-task-source-plugin-e2e-'))

  try {
    await installHelloTasks(orcaPage, tempRoot)
    const worktreesBefore = await countWorktrees(orcaPage)

    await openHelloTasks(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: 'Wire up the login form' })).toBeVisible({
      timeout: 15_000
    })
    await expect(orcaPage.getByRole('heading', { name: 'Fix the flaky upload test' })).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-task-list.png') })

    await selectStatus(orcaPage, 'Blocked')
    await expect(
      orcaPage.getByRole('heading', { name: 'Design review of the settings page' })
    ).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Wire up the login form' })).toBeHidden()

    await selectStatus(orcaPage, 'All')
    await orcaPage.getByRole('heading', { name: 'Wire up the login form' }).click()
    const detail = orcaPage.getByRole('dialog', { name: 'Wire up the login form' })
    await expect(detail).toContainText('Users can sign in with email and password.')
    await settleAnimations(orcaPage)
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-task-detail.png') })

    await detail.getByRole('button', { name: 'Start workspace' }).click()
    const agentPrompt = orcaPage.getByLabel('Agent prompt')
    await expect(agentPrompt).toHaveValue(
      'Build the login form described in docs/login.md, with tests.'
    )
    await expect(orcaPage.getByText('Starts with model sonnet, effort high.')).toBeVisible()
    await settleAnimations(orcaPage)
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-task-composer.png') })

    await orcaPage.keyboard.press('Escape')
    await expect(agentPrompt).toBeHidden()
    expect(await countWorktrees(orcaPage)).toBe(worktreesBefore)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('remembers filters, edits plugin settings, and links workspaces to tasks', async ({
  orcaPage
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-task-source-plugin-e2e-'))
  let worktreeId: string | null = null

  try {
    const pluginKey = await installHelloTasks(orcaPage, tempRoot)
    await openHelloTasks(orcaPage)
    await selectStatus(orcaPage, 'In progress')
    await expect(orcaPage.getByRole('heading', { name: 'Wire up the login form' })).toBeHidden()

    // Leaving Tasks and opening it plainly again restores the source and its filter.
    await orcaPage.evaluate(() => window.__store?.getState().closeTaskPage())
    await orcaPage.evaluate(() => window.__store?.getState().openTaskPage())
    await expect(orcaPage.getByRole('combobox', { name: 'Status' })).toContainText('In progress', {
      timeout: 15_000
    })
    await expect(orcaPage.getByRole('heading', { name: 'Fix the flaky upload test' })).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Wire up the login form' })).toBeHidden()

    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'plugins', repoId: null })
      state?.openSettingsPage()
    })
    await orcaPage.getByRole('tab', { name: /^Installed/ }).click()
    await orcaPage
      .locator(`[data-plugin-key="${pluginKey}"]`)
      .getByRole('button', { name: 'Settings' })
      .click()
    const settingsDialog = orcaPage.getByRole('dialog', { name: 'Hello Tasks settings' })
    const showBlocked = settingsDialog.getByRole('switch', { name: 'Show blocked tasks' })
    await showBlocked.click()
    await expect(showBlocked).toHaveAttribute('aria-checked', 'false')
    await settleAnimations(orcaPage)
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-settings-dialog.png') })
    await settingsDialog.getByRole('button', { name: 'Done' }).click()

    await openHelloTasks(orcaPage)
    await selectStatus(orcaPage, 'All')
    await expect(orcaPage.getByRole('heading', { name: 'Wire up the login form' })).toBeVisible({
      timeout: 15_000
    })
    await expect(
      orcaPage.getByRole('heading', { name: 'Design review of the settings page' })
    ).toBeHidden()

    worktreeId = await orcaPage.evaluate(async (key) => {
      const state = window.__store?.getState()
      const seeded = state && Object.values(state.worktreesByRepo).flat()[0]
      if (!state || !seeded) {
        throw new Error('no seeded worktree')
      }
      const created = await state.createWorktree(seeded.repoId, `login-form-${Date.now()}`)
      await state.updateWorktreeMeta(created.worktree.id, {
        linkedPluginTask: {
          pluginKey: key,
          sourceId: 'samples',
          itemId: 'login-form',
          title: 'Wire up the login form',
          sourceTitle: 'Hello Tasks'
        }
      })
      return created.worktree.id
    }, pluginKey)

    await openHelloTasks(orcaPage)
    await expect(
      orcaPage.getByRole('button', { name: /^Open workspace login-form-/ })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-task-linked-row.png') })

    await orcaPage
      .getByRole('button', { name: 'Open in Hello Tasks: Wire up the login form' })
      .click()
    const detail = orcaPage.getByRole('dialog', { name: 'Wire up the login form' })
    await expect(detail.getByRole('button', { name: 'Open workspace' })).toBeVisible({
      timeout: 15_000
    })
    await expect(detail.getByRole('button', { name: 'Start another' })).toBeVisible()
    await settleAnimations(orcaPage)
    await orcaPage.screenshot({ path: testInfo.outputPath('plugin-task-linked-detail.png') })
  } finally {
    try {
      if (worktreeId) {
        await removeWorktreeViaStore(orcaPage, worktreeId)
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
})
