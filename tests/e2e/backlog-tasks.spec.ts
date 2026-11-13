import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { test as base, expect } from './helpers/orca-app'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'

// A stand-in `claude` records its argv so draft delivery is proven without a real provider.
const fakeAgentDir = mkdtempSync(path.join(tmpdir(), 'orca-backlog-agent-'))
const fakeAgentLedger = path.join(fakeAgentDir, 'claude-argv.jsonl')
const fakeAgentSource = `
require('node:fs').appendFileSync(process.env.ORCA_E2E_BACKLOG_AGENT_LEDGER, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdin.resume()
setInterval(() => {}, 60_000)
`
if (process.platform === 'win32') {
  writeFileSync(path.join(fakeAgentDir, 'fake-claude.js'), fakeAgentSource)
  writeFileSync(
    path.join(fakeAgentDir, 'claude.cmd'),
    '@echo off\r\nnode "%~dp0\\fake-claude.js" %*\r\n'
  )
} else {
  writeFileSync(path.join(fakeAgentDir, 'claude'), `#!/usr/bin/env node\n${fakeAgentSource}`)
  chmodSync(path.join(fakeAgentDir, 'claude'), 0o755)
}
const fakeAgentCommand = buildFakeAgentCommandOverride(
  path.join(fakeAgentDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
)

function readAgentLaunches(): string[][] {
  return existsSync(fakeAgentLedger)
    ? readFileSync(fakeAgentLedger, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : []
}

const test = base.extend({
  launchEnv: {
    PATH: `${fakeAgentDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_BACKLOG_AGENT_LEDGER: fakeAgentLedger
  },
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

/** Installs the pinned CLI and a configured Backlog project into the disposable repository. */
async function seedBacklogProject(testRepoPath: string): Promise<string> {
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
  return configPath
}

/** Shrinks the hidden window to the narrowest supported desktop width without showing it. */
async function setWindowSize(electronApp: ElectronApplication, width: number, height: number) {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.setMinimumSize(0, 0)
      window?.setSize(size.width, size.height)
    },
    { width, height }
  )
}

/** Fails when a control is clipped by the viewport or has no usable hit area. */
async function expectInViewport(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(box, 'control is rendered').not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(16)
  expect(box!.height).toBeGreaterThanOrEqual(16)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
}

/** Tabs forward until the target holds focus, proving it is reachable without a pointer. */
async function tabTo(page: Page, target: Locator, limit = 25): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate((node) => node === document.activeElement)) {
      return
    }
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

test('Backlog list, read, CLI create/edit, error recovery and launch composer', async ({
  orcaPage,
  testRepoPath,
  electronApp
}, testInfo) => {
  const configPath = await seedBacklogProject(testRepoPath)
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
  await orcaPage.getByRole('button', { name: 'Save task', exact: true }).click()
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'Edit task', exact: true })).toBeFocused()
  await expect(orcaPage.getByRole('button', { name: 'Edit task', exact: true })).toBeEnabled()
  await orcaPage.screenshot({ path: testInfo.outputPath('01-noop-saved.png') })
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

test('Backlog keyboard editing and delayed-failure recovery deliver the edited draft', async ({
  orcaPage,
  testRepoPath,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await seedBacklogProject(testRepoPath)
  const commit = await runProcess({
    program: 'git',
    args: [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Orca E2E',
      '-c',
      'user.email=e2e@test.local',
      'commit',
      '--allow-empty',
      '-m',
      'seed'
    ],
    cwd: testRepoPath
  })
  expect(commit.code, commit.stderr).toBe(0)
  await orcaPage.evaluate(
    async ({ command, windowsShell, repoPath }) => {
      const state = window.__store?.getState()
      const repo = state?.repos.find((candidate) => candidate.path === repoPath)
      // A local setup command renders the startup-policy switch without a trust prompt.
      await state?.updateRepo(repo!.id, {
        hookSettings: {
          mode: 'auto',
          commandSourcePolicy: 'local-only',
          scripts: { setup: 'echo backlog-setup', archive: '' }
        }
      })
      await state?.updateSettings({
        agentCmdOverrides: { claude: command },
        terminalWindowsShell: windowsShell,
        defaultTuiAgent: 'claude',
        disabledTuiAgents: []
      })
    },
    { command: fakeAgentCommand, windowsShell: FAKE_AGENT_WINDOWS_SHELL, repoPath: testRepoPath }
  )
  await setWindowSize(electronApp, 600, 400)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  await orcaPage.evaluate(() => window.__store?.getState().openTaskPage())
  await orcaPage.locator('[data-task-source="backlog"]').click()
  const seedRow = orcaPage.getByRole('button', { name: /TASK-1 Seed with handle/ })
  await expect(seedRow).toBeVisible()

  // Create through the keyboard; a confirmed save returns focus to its invoker.
  const newTask = orcaPage.getByRole('button', { name: 'New task', exact: true })
  await expectInViewport(orcaPage, newTask)
  await newTask.focus()
  await orcaPage.keyboard.press('Enter')
  const editor = orcaPage.getByRole('dialog', { name: 'New Backlog task' })
  await expect(editor.getByLabel('Title', { exact: true })).toBeFocused()
  await orcaPage.keyboard.type('Keyboard created task')
  await orcaPage.keyboard.press('Tab')
  await expect(editor.getByLabel('Description', { exact: true })).toBeFocused()
  await orcaPage.keyboard.type('Created without a pointer')
  for (const control of [
    editor.getByRole('combobox', { name: 'Task status' }),
    editor.getByRole('button', { name: 'Cancel', exact: true }),
    editor.getByRole('button', { name: 'Save task', exact: true })
  ]) {
    await expectInViewport(orcaPage, control)
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('06-narrow-create-editor.png') })
  await tabTo(orcaPage, editor.getByRole('button', { name: 'Save task', exact: true }))
  await orcaPage.keyboard.press('Enter')
  const createdRow = orcaPage.getByRole('button', { name: /Keyboard created task/ })
  await expect(createdRow).toBeVisible()
  await expect(newTask).toBeFocused()

  // Escape closes the edit dialog without saving and returns focus to Edit task.
  await createdRow.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByRole('article')).toContainText('Created without a pointer')
  const editTask = orcaPage.getByRole('button', { name: 'Edit task', exact: true })
  await expectInViewport(orcaPage, editTask)
  await editTask.focus()
  await orcaPage.keyboard.press('Enter')
  const editTitle = orcaPage.getByRole('dialog').getByLabel('Title', { exact: true })
  await expect(editTitle).toBeFocused()
  await orcaPage.keyboard.type(' (unsaved)')
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await expect(editTask).toBeFocused()
  await expect(orcaPage.getByRole('heading', { level: 2 })).not.toContainText('(unsaved)')

  // A slow then failing setup-policy save keeps preparation past the 1.5s composer handoff.
  await electronApp.evaluate(({ ipcMain }) => {
    type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron keeps invoke handlers in this private map; the throw below covers its absence.
    const registry = (ipcMain as unknown as { _invokeHandlers?: Map<string, InvokeHandler> })
      ._invokeHandlers
    const production = registry?.get('repos:update')
    if (!production) {
      throw new Error('repos:update handler was not registered in the main process')
    }
    let failNextPolicySave = true
    ipcMain.removeHandler('repos:update')
    ipcMain.handle('repos:update', async (event, args, ...rest) => {
      const policy = (args as { updates?: { hookSettings?: { setupAgentStartupPolicy?: string } } })
        .updates?.hookSettings?.setupAgentStartupPolicy
      if (failNextPolicySave && policy) {
        failNextPolicySave = false
        await new Promise((resolve) => setTimeout(resolve, 4_000))
        throw new Error('E2E injected setup-policy save failure')
      }
      return production(event, args, ...rest)
    })
  })

  const startWorkspace = orcaPage.getByRole('button', { name: 'Start workspace', exact: true })
  await startWorkspace.focus()
  await orcaPage.keyboard.press('Enter')
  const composer = orcaPage.getByRole('dialog')
  const nameField = composer.getByRole('textbox').first()
  await expect(nameField).toHaveValue(/^TASK-\d+ Keyboard created task$/)
  const create = composer.getByRole('button', { name: /Create worktree/ })
  await expectInViewport(orcaPage, create)
  await orcaPage.screenshot({ path: testInfo.outputPath('07-narrow-composer.png') })
  const advanced = composer.getByRole('button', { name: 'Advanced' })
  await tabTo(orcaPage, advanced)
  await orcaPage.keyboard.press('Enter')
  const waitForSetup = composer.getByRole('switch', {
    name: 'Wait for setup to complete before starting agent'
  })
  await tabTo(orcaPage, waitForSetup)
  await orcaPage.keyboard.press('Space')
  await tabTo(orcaPage, create)
  await orcaPage.keyboard.press('Enter')
  await expect(composer).toHaveCount(0, { timeout: 5_000 })
  const reopen = orcaPage.getByRole('button', { name: 'Reopen', exact: true })
  await expect(reopen).toBeVisible({ timeout: 15_000 })
  await expectInViewport(orcaPage, reopen)
  await orcaPage.screenshot({ path: testInfo.outputPath('08-narrow-recovery-toast.png') })
  await reopen.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(nameField).toHaveValue(/^TASK-\d+ Keyboard created task$/)
  await expect(nameField).toBeFocused()
  await orcaPage.screenshot({ path: testInfo.outputPath('09-narrow-reopened.png') })

  // The resubmitted launch carries the task's draft as unsent agent input.
  await orcaPage.keyboard.press('ControlOrMeta+Enter')
  // Version probes also run the stand-in; only the launch carries --prefill.
  const draftLaunch = () => readAgentLaunches().find((argv) => argv.includes('--prefill'))
  await expect.poll(() => Boolean(draftLaunch()), { timeout: 60_000 }).toBe(true)
  const argv = draftLaunch() ?? []
  const prefill = argv[argv.indexOf('--prefill') + 1] ?? ''
  expect(prefill).toMatch(/Work on Backlog\.md task TASK-\d+\./)
  expect(prefill).toContain('Created without a pointer')
  await orcaPage.screenshot({ path: testInfo.outputPath('10-draft-delivered.png') })
})
