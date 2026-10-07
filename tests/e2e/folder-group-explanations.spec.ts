import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openSidebarProjectDialog } from './helpers/sidebar-project-dialog'
import { runProcess } from '../../src/shared/child-process/run-process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'

async function chooseFolder(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folderPath],
      bookmarks: []
    })
  }, selectedPath)
}

async function capture(page: Page, outputPath: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const screenshot = await cdp.send('Page.captureScreenshot')
    writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'))
  } finally {
    await cdp.detach()
  }
}

test('Git-root explanation requires explicit group import; ordinary browsing stays uninterrupted', async ({
  electronApp,
  orcaPage,
  seededRepoPath
}, testInfo) => {
  await chooseFolder(electronApp, seededRepoPath)
  await openSidebarProjectDialog(orcaPage)
  await orcaPage.getByRole('button', { name: /^Import folder as group/ }).click()
  const groupDialog = orcaPage.getByRole('dialog', { name: 'Import folder as group', exact: true })
  await expect(groupDialog.getByText(/Nested repository scanning was skipped/)).toBeVisible()
  await expect(groupDialog.getByRole('button', { name: 'Open project', exact: true })).toBeEnabled()
  await expect(groupDialog.getByRole('button', { name: 'Yes, import as group' })).toHaveCount(0)
  await capture(orcaPage, testInfo.outputPath('git-root-explanation.png'))
  await groupDialog.getByRole('button', { name: 'Open project', exact: true }).click()
  await expect(groupDialog).toHaveCount(0)

  await openSidebarProjectDialog(orcaPage)
  await orcaPage.getByRole('button', { name: /^Import folder as group/ }).click()
  await expect(groupDialog).toBeVisible()
  await groupDialog.getByRole('button', { name: 'Back', exact: true }).click()
  await orcaPage.getByRole('button', { name: /^Browse folder/ }).click()
  await expect(
    orcaPage.getByRole('dialog', { name: /Add a project|Import folder as group/ })
  ).toHaveCount(0)
  await expect(orcaPage.getByText(/Nested repository scanning was skipped/)).toHaveCount(0)
})

for (const fullyIgnored of [false, true]) {
  test(`explains ${fullyIgnored ? 'zero results' : 'partial discovery'} without changing ignore files`, async ({
    electronApp,
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-group-explanations-')))
    registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
    for (const name of ['api', 'web']) {
      const repoPath = path.join(root, name)
      mkdirSync(repoPath)
      writeFileSync(path.join(repoPath, 'README.md'), name)
      for (const args of [
        ['init'],
        ['add', '.'],
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-m',
          'seed'
        ]
      ]) {
        const result = await runProcess({ program: 'git', args, cwd: repoPath, timeoutMs: 10000 })
        expect(result.code, result.stderr).toBe(0)
      }
    }
    const ignoreContent = fullyIgnored ? '/api/\n/web/\n' : '/web/\n'
    writeFileSync(path.join(root, '.gitignore'), ignoreContent)
    await chooseFolder(electronApp, root)
    await openSidebarProjectDialog(orcaPage)
    await orcaPage.getByRole('button', { name: /^Import folder as group/ }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Import repositories from folder/ })
    await expect(
      dialog.getByText(`Found ${fullyIgnored ? '0 repositories' : '1 repository'} in`, {
        exact: false
      })
    ).toBeVisible()
    await expect(
      dialog.getByText(`Folders: ${fullyIgnored ? 2 : 1}. Excluded by .gitignore`, { exact: true })
    ).toBeVisible()
    const summary = dialog.locator('summary')
    await summary.focus()
    await summary.press('Enter')
    await expect(dialog.locator('details')).toHaveAttribute('open', '')
    await expect(
      dialog.getByText(`${path.join(root, '.gitignore')}:1`, { exact: true })
    ).toBeVisible()
    await expect(
      dialog.getByRole('button', { name: 'Yes, import as group', exact: true })
    ).toBeEnabled({ enabled: !fullyIgnored })
    await capture(orcaPage, testInfo.outputPath('exclusions.png'))
    const actual = readFileSync(path.join(root, '.gitignore'), 'utf8')
    expect(actual).toBe(ignoreContent)
  })
}
