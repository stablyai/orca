import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// Why: the conversion commits via the app's main process, which reads the host
// git identity. CI hosts may have none configured, so pin one through the
// launch env (the fixture forwards launchEnv to the Electron process).
test.use({
  launchEnv: {
    GIT_AUTHOR_NAME: 'E2E Convert',
    GIT_AUTHOR_EMAIL: 'e2e-convert@test.local',
    GIT_COMMITTER_NAME: 'E2E Convert',
    GIT_COMMITTER_EMAIL: 'e2e-convert@test.local'
  }
})

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  // Why: a host-level git lock/prompt could otherwise block a worker forever;
  // fail fast so CI stays predictable.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000
  })
}

function createNonGitFolderFixture(): string {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-convert-'))
  tempRoots.push(rootPath)
  const folderPath = path.join(rootPath, 'legacy-project')
  mkdirSync(folderPath, { recursive: true })
  writeFileSync(path.join(folderPath, 'index.js'), 'console.log("hello")\n')
  // A secret that must NOT land in history once a .gitignore is generated.
  writeFileSync(path.join(folderPath, '.env'), 'SECRET=do-not-commit\n')
  return folderPath
}

test.afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.describe('Convert non-git folder to a Git repository', () => {
  test('offers Convert in the dialog and turns the folder into a full git project', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const folderPath = createNonGitFolderFixture()
    expect(existsSync(path.join(folderPath, '.git'))).toBe(false)

    // Open the non-git dialog directly (the OS folder picker can't be driven in
    // E2E); this is the same modal the failed add-as-git flow opens.
    await orcaPage.evaluate((p) => {
      window.__store?.getState().openModal('confirm-non-git-folder', { folderPath: p })
    }, folderPath)

    const dialog = orcaPage.getByRole('dialog', { name: /This folder isn.t a Git repository/i })
    await expect(dialog).toBeVisible()

    // Both actions are present (dismiss is the dialog's top-right close button).
    await expect(dialog.getByRole('button', { name: 'Open as Folder' })).toBeVisible()
    const convertButton = dialog.getByRole('button', { name: 'Convert to Git Repository' })
    await expect(convertButton).toBeVisible()

    await orcaPage.screenshot({ path: path.join(testInfo.outputDir, 'convert-dialog.png') })
    await testInfo.attach('convert-dialog', {
      path: path.join(testInfo.outputDir, 'convert-dialog.png'),
      contentType: 'image/png'
    })

    await convertButton.click()

    // The dialog closes and the converted project becomes visible in the
    // sidebar, proving the user no longer needs to remove and re-import it.
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(
      orcaPage
        .locator('[data-worktree-sidebar]')
        .getByText('legacy-project', { exact: true })
        .first()
    ).toBeVisible({ timeout: 30_000 })

    await orcaPage.screenshot({ path: path.join(testInfo.outputDir, 'after-convert.png') })
    await testInfo.attach('after-convert', {
      path: path.join(testInfo.outputDir, 'after-convert.png'),
      contentType: 'image/png'
    })

    // Filesystem truth: real repo, .gitignore written, secret excluded, and a
    // base commit exists so a worktree can be created (the unborn-HEAD bug).
    expect(existsSync(path.join(folderPath, '.git'))).toBe(true)
    expect(existsSync(path.join(folderPath, '.gitignore'))).toBe(true)

    const tracked = git(folderPath, ['ls-files']).split('\n').filter(Boolean)
    expect(tracked).toContain('index.js')
    expect(tracked).toContain('.gitignore')
    expect(tracked).not.toContain('.env')

    expect(() => git(folderPath, ['rev-parse', '--verify', 'HEAD^{commit}'])).not.toThrow()

    const worktreePath = path.join(folderPath, '..', 'wt-feature')
    expect(() =>
      git(folderPath, ['worktree', 'add', '--no-track', '-b', 'feature', worktreePath, 'HEAD'])
    ).not.toThrow()
    expect(existsSync(path.join(worktreePath, 'index.js'))).toBe(true)
  })
})
