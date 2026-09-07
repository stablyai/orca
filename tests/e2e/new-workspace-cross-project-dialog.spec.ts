import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const LONG_REPOSITORY_NAME = 'cross-project-dialog-long-repository-name'.repeat(3)
const LONG_REPOSITORY_SLUG = LONG_REPOSITORY_NAME
const CURRENT_REPOSITORY_NAME = 'current-project-name'.repeat(3)

function runGit(repositoryPath: string, args: string[]): void {
  execFileSync('git', args, { cwd: repositoryPath, stdio: 'pipe' })
}

function createGitRepository(repositoryPath: string): void {
  mkdirSync(repositoryPath, { recursive: true })
  runGit(repositoryPath, ['init'])
  runGit(repositoryPath, ['config', 'user.email', 'e2e@test.local'])
  runGit(repositoryPath, ['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repositoryPath, 'README.md'), '# Cross-project dialog E2E\n')
  runGit(repositoryPath, ['add', '-A'])
  runGit(repositoryPath, ['commit', '-m', 'Initial commit'])
}

test('keeps long repository names inside the cross-project confirmation dialog', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-cross-project-dialog-'))
  const secondRepositoryPath = path.join(tempRoot, LONG_REPOSITORY_NAME)
  createGitRepository(secondRepositoryPath)

  try {
    const secondRepositoryId = await orcaPage.evaluate(async (repositoryPath) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const repository = await store.getState().addRepoPath(repositoryPath)
      if (!repository) {
        throw new Error(`Failed to add repository at ${repositoryPath}`)
      }
      return repository.id
    }, secondRepositoryPath)

    const currentRepositoryId = await orcaPage.evaluate(() => {
      const store = window.__store
      const activeWorktreeId = store?.getState().activeWorktreeId
      if (!store || !activeWorktreeId) {
        throw new Error('active repository is unavailable')
      }
      const entry = Object.entries(store.getState().worktreesByRepo).find(([, worktrees]) =>
        worktrees.some((worktree) => worktree.id === activeWorktreeId)
      )
      if (!entry) {
        throw new Error('active repository could not be resolved')
      }
      return entry[0]
    })
    await orcaPage.evaluate(
      async ({ repositoryId, displayName }) => {
        const store = window.__store
        if (!store || !(await store.getState().updateRepo(repositoryId, { displayName }))) {
          throw new Error('failed to update the current repository name')
        }
      },
      { repositoryId: currentRepositoryId, displayName: CURRENT_REPOSITORY_NAME }
    )

    await electronApp.evaluate(
      ({ ipcMain }, { repositoryId, repositorySlug }) => {
        ipcMain.removeHandler('gh:repoSlug')
        ipcMain.handle('gh:repoSlug', (_event, args: { repoId?: string }) =>
          args.repoId === repositoryId
            ? { owner: 'e2e', repo: repositorySlug }
            : { owner: 'e2e', repo: 'current-project' }
        )
      },
      { repositoryId: secondRepositoryId, repositorySlug: LONG_REPOSITORY_SLUG }
    )

    // Why: 640px is the narrowest desktop layout, where the footer switches to a row.
    await orcaPage.setViewportSize({ width: 640, height: 720 })
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()

    const composer = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await expect(composer).toBeVisible()
    const nameInput = composer.locator('[data-workspace-name-input="true"]')
    await expect(nameInput).toBeVisible()
    await nameInput.fill(`https://github.com/e2e/${LONG_REPOSITORY_SLUG}/issues/42`)

    const confirmation = orcaPage.getByRole('dialog', { name: 'Switch project?' })
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText(LONG_REPOSITORY_NAME)

    if (process.env.ORCA_VISUAL_PROOF === '1') {
      mkdirSync(testInfo.outputDir, { recursive: true })
      await confirmation.screenshot({ path: testInfo.outputPath('cross-project-dialog.png') })
    }

    const layout = await confirmation.evaluate((dialog) => {
      const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]')
      if (!footer) {
        throw new Error('cross-project dialog footer is missing')
      }
      const dialogRect = dialog.getBoundingClientRect()
      const dialogStyles = getComputedStyle(dialog)
      const contentLeft = dialogRect.left + Number.parseFloat(dialogStyles.paddingLeft)
      const contentRight = dialogRect.right - Number.parseFloat(dialogStyles.paddingRight)
      const footerRect = footer.getBoundingClientRect()
      const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-slot="button"]'))
      return {
        dialogFits: dialog.scrollWidth <= dialog.clientWidth,
        footerFits:
          footer.scrollWidth <= footer.clientWidth &&
          footerRect.left >= contentLeft - 1 &&
          footerRect.right <= contentRight + 1,
        buttonsFit: buttons.every((button) => {
          const rect = button.getBoundingClientRect()
          return (
            button.scrollWidth <= button.clientWidth + 1 &&
            rect.left >= contentLeft - 1 &&
            rect.right <= contentRight + 1
          )
        })
      }
    })

    expect(layout).toEqual({ dialogFits: true, footerFits: true, buttonsFit: true })
  } finally {
    await orcaPage
      .evaluate(() => {
        window.__store?.getState().closeModal()
      })
      .catch(() => {
        /* page may already be torn down */
      })
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
