/**
 * The Workspace Layout setting decides where a new worktree lands. This drives the real Settings
 * control and the real create composer, then checks the directory git created on disk and the
 * terminal's working directory, so a renderer-only or store-only regression cannot pass.
 */
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { removeWorktreeViaStore } from './helpers/dead-terminal'
import { expect, test } from './helpers/orca-app'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { closeSettingsPage } from './helpers/ssh-config-host-picker'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

async function openGeneralSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'general', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  // Why: first-run announcements can cover the settings pane on fresh profiles.
  const maybeLater = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLater.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLater.click()
  }
}

async function createWorkspace(page: Page, name: string): Promise<void> {
  await openSidebarWorkspaceComposer(page)
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

test('creates a new worktree next to the repository once that layout is chosen', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(180_000)
  const siblingRoot = `${testRepoPath}.worktrees`
  registerPostElectronShutdownCleanup(async () => {
    rmSync(siblingRoot, { recursive: true, force: true })
  })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const workspaceDir = await orcaPage.evaluate(
    () => window.__store!.getState().settings?.workspaceDir ?? ''
  )

  await openGeneralSettings(orcaPage)
  const layout = orcaPage.getByLabel('Workspace Layout')
  await layout.scrollIntoViewIfNeeded()
  await expect(layout).toHaveText('Nested')
  await layout.click()
  const sibling = orcaPage.getByRole('option', { name: /Next to repository/ })
  await expect(sibling).toContainText('…/my-repo.worktrees/feature')
  await orcaPage.screenshot({
    path: testInfo.outputPath('worktree-layout-options.png'),
    animations: 'disabled'
  })
  await sibling.click()
  await expect(layout).toHaveText('Next to repository')
  await expect(
    orcaPage.getByText('Ignores the workspace directory', { exact: false })
  ).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('worktree-layout-selected.png'),
    animations: 'disabled'
  })
  await closeSettingsPage(orcaPage)

  const name = `sibling-layout-${Date.now()}`
  const expectedPath = path.join(siblingRoot, name)
  let createdWorktreeId: string | null = null
  try {
    await createWorkspace(orcaPage, name)
    await expect(
      orcaPage.locator('[role="option"][aria-current="page"]').filter({ hasText: name })
    ).toBeVisible({ timeout: 30_000 })
    createdWorktreeId = await waitForActiveWorktree(orcaPage)

    // The directory git checked out is beside the repo, not under the workspace directory.
    await expect.poll(() => existsSync(path.join(expectedPath, '.git'))).toBe(true)
    expect(existsSync(path.join(workspaceDir, path.basename(testRepoPath), name))).toBe(false)
    const shownPath = [path.basename(siblingRoot), name].join('/')
    const activeRow = orcaPage
      .locator('[role="option"][aria-current="page"]')
      .filter({ hasText: name })
    expect((await activeRow.getAttribute('data-worktree-id'))?.replace(/\\/g, '/')).toContain(
      shownPath
    )

    await createTerminalTabFromMenu(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    // Why the neutral prompt: the screenshot must not carry the runner's user or host name.
    await execInTerminal(
      orcaPage,
      ptyId,
      process.platform === 'win32' ? 'cls; pwd' : "PS1='$ '; clear; pwd"
    )
    await waitForTerminalOutput(
      orcaPage,
      process.platform === 'win32' ? shownPath.replaceAll('/', '\\') : shownPath
    )
    await orcaPage.screenshot({
      path: testInfo.outputPath('worktree-layout-after.png'),
      animations: 'disabled'
    })
  } finally {
    if (createdWorktreeId) {
      await removeWorktreeViaStore(orcaPage, createdWorktreeId)
    }
  }
})
