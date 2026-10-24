/**
 * E2E: Alt+P (⌥P on macOS) jumps from the composer's name field to Project.
 *
 * Why E2E: the shortcut is a capture-phase window listener in the composer
 * modal, and the Project field opens its list on focus — only the real dialog
 * shows the jump, the list, and the return to the name field after a pick.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const SECOND_PROJECT_NAME = 'project-shortcut-second-project'

function createGitRepo(repoPath: string): void {
  mkdirSync(repoPath, { recursive: true })
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  }
  run(['init'])
  run(['config', 'user.email', 'e2e@test.local'])
  run(['config', 'user.name', 'E2E Test'])
  writeFileSync(path.join(repoPath, 'README.md'), '# Project shortcut E2E\n')
  run(['add', '-A'])
  run(['commit', '-m', 'Initial commit'])
}

test.describe('New workspace composer project shortcut', () => {
  let tempRoot: string

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-project-shortcut-'))
    const secondRepoPath = path.join(tempRoot, SECOND_PROJECT_NAME)
    createGitRepo(secondRepoPath)
    await orcaPage.evaluate(async (repoPath) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      if (!(await store.getState().addRepoPath(repoPath))) {
        throw new Error(`Failed to add repo at ${repoPath}`)
      }
    }, secondRepoPath)
  })

  test.afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('Alt+P focuses Project, and picking one returns to the name field', async ({
    orcaPage
  }) => {
    await orcaPage.evaluate(() => {
      window.__store?.getState().openModal('new-workspace-composer', {})
    })
    const composer = orcaPage.getByRole('dialog')
    const nameInput = composer.locator('[data-workspace-name-input="true"]')
    const projectInput = composer.getByRole('combobox', { name: 'Project' })
    await expect(nameInput).toBeFocused()

    await orcaPage.keyboard.press('Alt+KeyP')

    await expect(projectInput).toBeFocused()
    await expect(projectInput).toHaveAttribute('aria-expanded', 'true')
    await expect(nameInput).toHaveValue('')

    await orcaPage.keyboard.type('shortcut-second')
    await orcaPage.keyboard.press('Enter')

    await expect(composer.locator('div[data-project-combobox-root="true"]')).toContainText(
      SECOND_PROJECT_NAME
    )
    await expect(nameInput).toBeFocused()
  })
})
