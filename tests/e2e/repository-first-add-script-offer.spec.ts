import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { waitForSessionReady } from './helpers/store'

const tempRoots: string[] = []
const MARKER_FILE = '.orca-add-script-ran'
const SCRIPT_TEXT = `echo orca-add-script-ran > ${MARKER_FILE}`

test.afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function createGitRepo(prefix: string, name: string): Promise<string> {
  // Why: macOS os.tmpdir() (/var/...) symlinks to /private/var/..., and the app
  // canonicalizes repo.path via `git rev-parse --show-toplevel` on add.
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), prefix)))
  tempRoots.push(rootPath)
  const repoPath = path.join(rootPath, name)

  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: repoPath, stdio: 'pipe' })
  writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n`)
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repoPath, stdio: 'pipe' })
  return repoPath
}

async function chooseFolderInNativeDialog(
  electronApp: ElectronApplication,
  folderPath: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await electronApp.evaluate(({ dialog }, selectedPath) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [selectedPath],
          bookmarks: []
        })
      }, folderPath)
      return
    } catch (error) {
      if (
        attempt === 2 ||
        !(error instanceof Error) ||
        !error.message.includes('Execution context was destroyed')
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

async function pinEnglishUi(page: Page): Promise<void> {
  // Why: the host OS locale drives Orca's default UI language, so locators must
  // not depend on the machine running the suite.
  await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await expect(
    page
      .locator('[data-sidebar-header-actions]')
      .getByRole('button', { name: 'Add project', exact: true })
  ).toBeVisible({ timeout: 20_000 })
}

async function configureAddScript(page: Page, script: string): Promise<void> {
  await page.evaluate(async (text) => {
    await window.api.settings.set({ repositoryAddScript: text })
  }, script)
}

async function addProjectFromSidebar(
  page: Page,
  electronApp: ElectronApplication,
  repoPath: string
): Promise<void> {
  await chooseFolderInNativeDialog(electronApp, repoPath)
  await openSidebarProjectDialog(page)
  const addDialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect(addDialog).toBeVisible()
  await addDialog.getByRole('button', { name: /Browse folder/i }).click()

  const confirmDialog = page.getByRole('dialog', { name: /^Add Project$/i })
  const needsConfirmation = await confirmDialog
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (needsConfirmation) {
    await confirmDialog.getByRole('button', { name: /^Add Project$/ }).click()
  }
}

async function expectRepoAdded(page: Page, repoPath: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (targetPath) =>
            window.__store?.getState().repos.some((repo) => repo.path === targetPath) ?? false,
          repoPath
        ),
      { timeout: 30_000, message: `repo was not added: ${repoPath}` }
    )
    .toBe(true)
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const file = testInfo.outputPath(`${name}.png`)
  mkdirSync(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, animations: 'disabled' })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
}

function addScriptPrompt(page: Page, repoName: string) {
  return page.getByRole('dialog', { name: new RegExp(`Run add script for ${repoName}`, 'i') })
}

test.describe('repository add script on first registration', () => {
  test('offers the configured script and runs it when the user chooses Run', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await pinEnglishUi(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 860 })
    const repoPath = await createGitRepo('orca-add-script-run-', 'add-script-run')
    const markerPath = path.join(repoPath, MARKER_FILE)
    await configureAddScript(orcaPage, SCRIPT_TEXT)

    await addProjectFromSidebar(orcaPage, electronApp, repoPath)
    await expectRepoAdded(orcaPage, repoPath)

    const prompt = addScriptPrompt(orcaPage, 'add-script-run')
    await expect(prompt).toBeVisible({ timeout: 20_000 })
    await expect(prompt.locator('pre')).toHaveText(SCRIPT_TEXT)
    await expect(prompt).toContainText(repoPath)
    await capture(orcaPage, testInfo, 'repository-add-script-prompt')

    await prompt.getByRole('button', { name: 'Run', exact: true }).click()

    await expect
      .poll(() => existsSync(markerPath), { timeout: 30_000, message: 'add script did not run' })
      .toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toContain('orca-add-script-ran')
    await expect(orcaPage.getByText('Add script finished')).toBeVisible({ timeout: 30_000 })
    await capture(orcaPage, testInfo, 'repository-add-script-finished')
  })

  test('adds the repository without running the script when the user chooses Skip', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await pinEnglishUi(orcaPage)
    await orcaPage.setViewportSize({ width: 1200, height: 860 })
    const repoPath = await createGitRepo('orca-add-script-skip-', 'add-script-skip')
    const markerPath = path.join(repoPath, MARKER_FILE)
    await configureAddScript(orcaPage, SCRIPT_TEXT)

    await addProjectFromSidebar(orcaPage, electronApp, repoPath)
    await expectRepoAdded(orcaPage, repoPath)

    const prompt = addScriptPrompt(orcaPage, 'add-script-skip')
    await expect(prompt).toBeVisible({ timeout: 20_000 })
    await capture(orcaPage, testInfo, 'repository-add-script-skip-prompt')

    await prompt.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(prompt).toBeHidden()

    // The skip decision is asynchronous; give it a beat before proving nothing ran.
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    expect(existsSync(markerPath)).toBe(false)
  })
})
