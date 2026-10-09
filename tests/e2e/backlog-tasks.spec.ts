import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { test as base, expect } from './helpers/orca-app'

const test = base.extend({
  /** Isolates real CLI mutations in an unborn repository and removes it after the scenario. */
  // oxlint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring.
  testRepoPath: async ({}, provideFixture) => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-backlog-e2e-')))
    try {
      const result = await runProcess({ program: 'git', args: ['init'], cwd: root })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      await provideFixture(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
test.use({ minimumSeededWorktreeCount: 1 })
test.skip(!process.env.ORCA_BACKLOG_TEST_PACKAGE, 'Requires the pinned Backlog CLI package')

test('Backlog list, read, CLI create/edit, error recovery and launch composer', async ({
  orcaPage,
  testRepoPath,
  electronApp
}, testInfo) => {
  const source = process.env.ORCA_BACKLOG_TEST_PACKAGE
  if (!source) {
    throw new Error('Set ORCA_BACKLOG_TEST_PACKAGE to a pinned backlog.md@1.48.0 installation')
  }
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
  expect(manifest.version).toBe('1.48.0')
  const nativePackage = `backlog.md-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
  for (const name of ['backlog.md', nativePackage]) {
    await cp(path.join(path.dirname(source), name), path.join(testRepoPath, 'node_modules', name), {
      recursive: true,
      dereference: true
    })
  }
  const configPath = path.join(testRepoPath, 'backlog.config.yml')
  await mkdir(path.join(testRepoPath, 'backlog', 'tasks'), { recursive: true })
  await writeFile(
    configPath,
    'project_name: E2E Backlog\nbacklog_directory: backlog\nstatuses: [Inbox, Released]\nauto_commit: false\nremote_operations: false\ncheck_active_branches: false\n'
  )
  await writeFile(
    path.join(testRepoPath, 'backlog', 'tasks', 'task-1 - seed.md'),
    '---\nid: TASK-1\ntitle: Seed with handle\nstatus: Inbox\nassignee: [@sara]\nreporter: @lee\n---\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\nSeed description\n<!-- SECTION:DESCRIPTION:END -->\n'
  )
  await orcaPage.evaluate(() => window.__store?.getState().openTaskPage())
  await orcaPage.locator('[data-task-source="backlog"]').click()
  await expect(orcaPage.getByRole('button', { name: /TASK-1 Seed with handle/ })).toBeVisible()
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('01-list.png') })
  await orcaPage.getByRole('button', { name: /TASK-1 Seed with handle/ }).click()
  await expect(orcaPage.getByRole('article')).toContainText('Seed description')
  await orcaPage.getByRole('button', { name: 'Edit task', exact: true }).click()
  await orcaPage.getByLabel('Title', { exact: true }).fill('Edited through real CLI')
  await orcaPage.getByRole('button', { name: 'Save task', exact: true }).click()
  await expect(
    orcaPage.getByRole('button', { name: /TASK-1 Edited through real CLI/ })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'New task', exact: true }).click()
  await orcaPage.getByLabel('Title', { exact: true }).fill('Created through real CLI')
  await orcaPage.getByLabel('Description', { exact: true }).fill('Created in disposable repository')
  await orcaPage.getByRole('button', { name: 'Save task', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: /Created through real CLI/ })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('02-saved.png') })
  await rename(configPath, `${configPath}.disabled`)
  await orcaPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(orcaPage.getByRole('alert')).toContainText('No Backlog.md configuration')
  await expect(orcaPage.getByRole('button', { name: /Created through real CLI/ })).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('03-error.png') })
  await rename(`${configPath}.disabled`, configPath)
  await orcaPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: /Created through real CLI/ })).toBeVisible()
  await orcaPage.getByRole('button', { name: /Created through real CLI/ }).click()
  await expect(orcaPage.getByRole('article')).toContainText('Created in disposable repository')
  await orcaPage.screenshot({ path: testInfo.outputPath('04-read.png') })
  await orcaPage.getByRole('button', { name: 'Start workspace', exact: true }).click()
  await expect(orcaPage.getByRole('dialog')).toBeVisible()
  await expect(orcaPage.getByRole('dialog').getByRole('textbox').first()).toHaveValue(
    'TASK-2 Created through real CLI'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('05-composer.png') })
})
