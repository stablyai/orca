import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '@orca/process-host'
import type { Page, ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession, attachRepoAndOpenTerminal } from './helpers/orca-restart'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'

async function createGitRepo(): Promise<string> {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-views-project-')))
  writeFileSync(path.join(directory, 'README.md'), 'Workspace views test\n')
  for (const args of [
    ['init', '-q'],
    ['add', 'README.md'],
    [
      '-c',
      'user.name=View Test',
      '-c',
      'user.email=view@example.invalid',
      'commit',
      '-q',
      '-m',
      'init'
    ]
  ]) {
    const result = await runProcess({ program: 'git', args, cwd: directory, timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
  }
  return directory
}

async function nameActiveTerminal(page: Page, name: string): Promise<string> {
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  if (process.platform !== 'win32') {
    await execInTerminal(page, ptyId, "PS1='test> '; printf '\\033[2J\\033[H'")
  }
  const id = await getActiveTabId(page)
  if (!id) {
    throw new Error('No active terminal')
  }
  await page.evaluate(({ id, name }) => window.__store!.getState().setTabCustomTitle(id, name), {
    id,
    name
  })
  return id
}

async function createViewThroughUi(page: Page, titles: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Views', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New view…', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Daily work')
  await page.getByRole('button', { name: 'Save view', exact: true }).click()
  for (const title of titles) {
    await page.getByRole('option').filter({ hasText: title }).click()
  }
  await page.getByRole('button', { name: 'Add selected panels', exact: true }).click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(titles.length)
}

function panelByTitle(page: Page, title: string) {
  return page
    .locator('[data-workspace-view-panel-id]')
    .filter({ has: page.getByRole('button', { name: `Panel actions: ${title}`, exact: true }) })
}

function readTerminalBuffers(page: Page, ids: string[]): Promise<Record<string, string>> {
  return page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          window.__paneManagers
            ?.get(id)
            ?.getPanes()
            .map((pane) => pane.serializeAddon?.serialize() ?? '')
            .join('\n') ?? ''
        ])
      ),
    ids
  )
}

function readTerminalIdentities(page: Page, ids: string[]): Promise<Record<string, string[]>> {
  return page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          window.__paneManagers
            ?.get(id)
            ?.getPanes()
            .map((pane) => pane.container.dataset.ptyId ?? '') ?? []
        ])
      ),
    ids
  )
}

test('chosen terminals across projects retain their sessions through focus, resize, expand and removal', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  // Cold project terminals must start before exercising the full layout and retention sequence.
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForSessionReady(page)
  const firstWorkspace = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const first = await nameActiveTerminal(page, 'View Alpha')
  await createTerminalTabFromMenu(page)
  const sibling = await nameActiveTerminal(page, 'View Beta')
  await page.screenshot({ path: test.info().outputPath('before-single-workspace.png') })
  const repoPath = await createGitRepo()
  registerPostElectronShutdownCleanup(async () =>
    rmSync(repoPath, { recursive: true, force: true })
  )
  const repoId = await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    return result.repo.id
  }, repoPath)
  let secondWorkspace: string | undefined
  await expect
    .poll(async () => {
      secondWorkspace = (await getAllWorktreeIds(page)).find((id) => id.startsWith(`${repoId}::`))
      return secondWorkspace
    })
    .toBeTruthy()
  if (!secondWorkspace) {
    throw new Error('Second project missing')
  }
  await switchToWorktree(page, secondWorkspace)
  await ensureTerminalVisible(page)
  const second = await nameActiveTerminal(page, 'View Gamma')
  const ids = [first, sibling, second]
  const before = await readTerminalIdentities(page, ids)
  expect(Object.values(before).every((values) => values.length > 0 && values.every(Boolean))).toBe(
    true
  )
  const normalLayouts = await page.evaluate(() =>
    JSON.stringify(window.__store!.getState().layoutByWorktree)
  )
  const elements = await Promise.all(
    ids.map((id) => page.locator(`[data-terminal-overlay-tab-id="${id}"] .xterm`).elementHandle())
  )
  await createViewThroughUi(page, ['View Alpha', 'View Beta', 'View Gamma'])
  for (const title of ['View Alpha', 'View Beta', 'View Gamma']) {
    await expect(panelByTitle(page, title)).toBeVisible()
  }
  await panelByTitle(page, 'View Alpha').locator('[data-workspace-view-panel-header]').click()
  await page.keyboard.type('echo VIEWS_INPUT_ALPHA_ONLY')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await readTerminalBuffers(page, ids))[first])
    .toContain('VIEWS_INPUT_ALPHA_ONLY')
  const buffers = await readTerminalBuffers(page, ids)
  expect(buffers[sibling]).not.toContain('VIEWS_INPUT_ALPHA_ONLY')
  expect(buffers[second]).not.toContain('VIEWS_INPUT_ALPHA_ONLY')
  expect(await page.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(
    firstWorkspace
  )
  const divider = page
    .locator('[role="separator"][aria-label="Resize panels"][aria-orientation="vertical"]')
    .first()
  const widthBefore = await panelByTitle(page, 'View Alpha').evaluate(
    (element) => element.getBoundingClientRect().width
  )
  const columnsBefore = await page.evaluate(
    (id) => window.__paneManagers?.get(id)?.getActivePane()?.terminal.cols ?? 0,
    first
  )
  await divider.focus()
  for (let step = 0; step < 5; step++) {
    await page.keyboard.press('ArrowLeft')
  }
  await expect
    .poll(() =>
      panelByTitle(page, 'View Alpha').evaluate((element) => element.getBoundingClientRect().width)
    )
    .toBeLessThan(widthBefore)
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.__paneManagers?.get(id)?.getActivePane()?.terminal.cols ?? 0,
        first
      )
    )
    .toBeLessThan(columnsBefore)
  await page.getByRole('radio', { name: 'Primary and stack' }).click()
  await panelByTitle(page, 'View Alpha')
    .getByRole('button', { name: 'Expand panel: View Alpha', exact: true })
    .click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Restore all panels: View Alpha', exact: true }).click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(3)
  await page.getByRole('button', { name: 'Fill window', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Show navigation', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate((tabId) => {
        const overlay = document.querySelector<HTMLElement>(
          `[data-terminal-overlay-tab-id="${tabId}"]`
        )
        const pane = overlay?.querySelector<HTMLElement>('.pane')
        if (!overlay || !pane) {
          return Infinity
        }
        return Math.abs(overlay.getBoundingClientRect().width - pane.getBoundingClientRect().width)
      }, first)
    )
    .toBeLessThan(5)
  await page.screenshot({ path: test.info().outputPath('after-chosen-project-panels.png') })
  expect(await readTerminalIdentities(page, ids)).toEqual(before)
  for (const element of elements) {
    expect(await element?.evaluate((node) => node.isConnected)).toBe(true)
  }
  await panelByTitle(page, 'View Alpha')
    .getByRole('button', { name: 'Remove from view; keep session open: View Alpha', exact: true })
    .click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(2)
  expect(await readTerminalIdentities(page, ids)).toEqual(before)
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click()
  await expect(page.locator('[data-workspace-view-toolbar]')).toHaveCount(0)
  expect(
    await page.evaluate(() => JSON.stringify(window.__store!.getState().layoutByWorktree))
  ).toBe(normalLayouts)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  expect(errors).toEqual([])
})

test('normal new-terminal commands replace the focused panel and preserve its previous session', async ({
  orcaPage: page
}) => {
  // Each terminal creation waits for a live PTY before checking panel replacement and retention.
  test.setTimeout(120_000)
  await waitForSessionReady(page)
  const workspaceId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const original = await nameActiveTerminal(page, 'Command Alpha')
  await createTerminalTabFromMenu(page)
  const sibling = await nameActiveTerminal(page, 'Command Beta')
  await createViewThroughUi(page, ['Command Alpha', 'Command Beta'])
  const target = panelByTitle(page, 'Command Alpha')
  const panelId = await target.getAttribute('data-workspace-view-panel-id')
  await target.locator('[data-workspace-view-panel-header]').click()
  await page.keyboard.press('ControlOrMeta+t')
  await waitForActiveTerminalManager(page)
  const createdPtyId = await waitForActivePanePtyId(page)
  const created = await getActiveTabId(page)
  expect(created).toBeTruthy()
  expect(created).not.toBe(original)
  if (!created || !panelId) {
    throw new Error('New terminal did not become active')
  }
  const panel = page.locator(`[data-workspace-view-panel-id="${panelId}"]`)
  const unifiedId = await page.evaluate(
    (id) => window.__store!.getState().getActiveTab(id)?.id,
    workspaceId
  )
  await expect(panel).toHaveAttribute('data-workspace-view-tab-id', unifiedId ?? '')
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(2)
  await page.keyboard.type("printf 'NEW_VIEW_TERMINAL_%s\\n' ONLY")
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await readTerminalBuffers(page, [created]))[created])
    .toContain('NEW_VIEW_TERMINAL_ONLY')
  const previous = await readTerminalBuffers(page, [original, sibling])
  expect(previous[original]).not.toContain('NEW_VIEW_TERMINAL_ONLY')
  expect(previous[sibling]).not.toContain('NEW_VIEW_TERMINAL_ONLY')
  await page.keyboard.type('sleep 300')
  await page.keyboard.press('Enter')
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.api.pty.inspectProcess(id), createdPtyId))
          .foregroundProcess
    )
    .toBe('sleep')
  await page.keyboard.press('ControlOrMeta+w')
  const confirmation = page.getByRole('dialog')
  await expect(confirmation.getByRole('heading', { name: 'Stop running command?' })).toBeVisible()
  await confirmation.getByRole('button', { name: 'Stop and Close', exact: true }).click()
  await expect(panel).toContainText('This panel is unavailable.')
  await expect(panelByTitle(page, 'Command Beta')).toHaveAttribute('data-current', 'true')
})

test('restores a saved view after restart and shows a placeholder when its tab closes', async ({
  testRepoPath
}) => {
  // The persistence check launches Electron twice and waits for restored terminal sessions.
  test.setTimeout(180_000)
  const session = createRestartSession(test.info())
  let app: ElectronApplication | undefined
  try {
    const first = await session.launch()
    app = first.app
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await nameActiveTerminal(first.page, 'Restart Alpha')
    await createTerminalTabFromMenu(first.page)
    await nameActiveTerminal(first.page, 'Restart Beta')
    await createViewThroughUi(first.page, ['Restart Alpha', 'Restart Beta'])
    await first.page.getByRole('radio', { name: 'Primary and stack' }).click()
    await session.close(app)
    app = undefined
    const restored = await session.launch()
    app = restored.app
    await waitForSessionReady(restored.page)
    await expect(restored.page.locator('[data-workspace-view-toolbar]')).toContainText('Daily work')
    await expect(restored.page.locator('[data-workspace-view-panel-id]')).toHaveCount(2)
    await expect(restored.page.getByRole('radio', { name: 'Primary and stack' })).toHaveAttribute(
      'data-state',
      'on'
    )
    const target = panelByTitle(restored.page, 'Restart Alpha')
    await target.locator('[data-workspace-view-panel-header]').click()
    await restored.page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
    await expect(target).toContainText('This panel is unavailable.')
    await expect(panelByTitle(restored.page, 'Restart Beta')).toBeVisible()
    await restored.page.screenshot({ path: test.info().outputPath('closed-panel-placeholder.png') })
  } finally {
    await session.dispose(app)
  }
})
