import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  switchToWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import { openMarkdownFixture, waitForRichMarkdownEditor } from './helpers/markdown-editor-fixture'

test.use({ seedTestRepo: false })

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
}

async function addProject(page: Page, root: string, slug: string, name: string) {
  const directory = path.join(root, name)
  mkdirSync(directory)
  git(directory, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(directory, 'PROJECT_ID'), `${slug}\n`)
  writeFileSync(path.join(directory, 'README.md'), `# ${name}\n\nIndependent project: ${slug}\n`)
  git(directory, 'add', '.')
  git(
    directory,
    '-c',
    'user.name=View Test',
    '-c',
    'user.email=view@example.invalid',
    'commit',
    '-qm',
    'initial'
  )
  const repoId = await page.evaluate(async (directory) => {
    const added = await window.api.repos.add({ path: directory })
    if ('error' in added) {
      throw new Error(added.error)
    }
    return added.repo.id
  }, directory)
  let workspaceId = ''
  await expect
    .poll(async () => {
      workspaceId = await page.evaluate(
        async ({ repoId, directory, name }) => {
          const state = window.__store!.getState()
          await state.fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
          await state.updateRepo(repoId, { displayName: name, externalWorktreeVisibility: 'show' })
          await state.fetchWorktrees(repoId)
          return (
            window.__store!.getState().worktreesByRepo[repoId]?.find((w) => w.path === directory)
              ?.id ?? ''
          )
        },
        { repoId, directory, name }
      )
      return workspaceId
    })
    .not.toBe('')
  return {
    repoId,
    workspaceId,
    directory,
    name,
    slug,
    gitDirectory: git(directory, 'rev-parse', '--absolute-git-dir')
  }
}

async function nameTerminal(page: Page, title: string) {
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  await execInTerminal(page, ptyId, "PS1='shell> '; printf '\\033[2J\\033[H'")
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('Terminal was not created')
  }
  await page.evaluate(
    ({ tabId, title }) => window.__store!.getState().setTabCustomTitle(tabId, title),
    { tabId, title }
  )
  return { tabId, ptyId, title }
}

function panel(page: Page, title: string) {
  return page.locator('[data-workspace-view-panel-id]').filter({
    has: page.getByRole('button', { name: `Panel actions: ${title}`, exact: true })
  })
}

test('chooses terminals and an editor across three independent projects, with worktrees available too', async ({
  orcaPage: page,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  // Three cold project sessions and an additional worktree must settle before the layout checks.
  test.setTimeout(240_000)
  test.skip(
    process.platform === 'win32',
    'This project-directory input proof uses POSIX shell commands'
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1600, height: 1000 })
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-separate-projects-')))
  registerPostElectronShutdownCleanup(async () => rmSync(root, { recursive: true, force: true }))
  const storefront = await addProject(page, root, 'storefront', 'Storefront')
  const payments = await addProject(page, root, 'payments-api', 'Payments API')
  const docs = await addProject(page, root, 'documentation', 'Documentation')
  const projects = [storefront, payments, docs]
  expect(new Set(projects.map((p) => p.repoId)).size).toBe(3)
  expect(new Set(projects.map((p) => p.gitDirectory)).size).toBe(3)
  for (const project of projects) {
    expect(project.gitDirectory).toBe(path.join(project.directory, '.git'))
  }

  await switchToWorktree(page, storefront.workspaceId)
  await ensureTerminalVisible(page)
  const app = await nameTerminal(page, 'App shell')
  await createTerminalTabFromMenu(page)
  const tests = await nameTerminal(page, 'Test shell')
  await page.keyboard.press('Escape')
  await switchToWorktree(page, payments.workspaceId)
  await ensureTerminalVisible(page)
  const api = await nameTerminal(page, 'API shell')

  const worktreePath = path.join(root, 'storefront-review')
  git(storefront.directory, 'worktree', 'add', '-q', '-b', 'review', worktreePath)
  let reviewWorkspace = ''
  await expect
    .poll(
      async () => {
        reviewWorkspace = await page.evaluate(
          async ({ repoId, worktreePath }) => {
            await window.__store!.getState().fetchWorktrees(repoId)
            return (
              window
                .__store!.getState()
                .worktreesByRepo[repoId]?.find((w) => w.path === worktreePath)?.id ?? ''
            )
          },
          { repoId: storefront.repoId, worktreePath }
        )
        return reviewWorkspace
      },
      { timeout: 15_000 }
    )
    .not.toBe('')
  await switchToWorktree(page, reviewWorkspace)
  await ensureTerminalVisible(page)
  const review = await nameTerminal(page, 'Review shell')
  expect(git(worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir')).toBe(
    storefront.gitDirectory
  )

  await switchToWorktree(page, docs.workspaceId)
  await ensureTerminalVisible(page)
  const notePath = path.join(docs.directory, 'Architecture.md')
  writeFileSync(
    notePath,
    '# Documentation project\n\nThis editor belongs to the separate Documentation repository.\n\n## Cross-project view\n\n- Storefront: app and test terminals\n- Payments API: API terminal\n- Documentation: this editor\n'
  )
  await openMarkdownFixture(
    page,
    { worktreeId: docs.workspaceId, rootPath: docs.directory },
    notePath
  )
  await expect(await waitForRichMarkdownEditor(page)).toContainText('Documentation project')

  await switchToWorktree(page, storefront.workspaceId)
  await page.getByRole('button', { name: 'Reveal active workspace', exact: true }).click()
  await page
    .locator(
      `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(storefront.workspaceId)}]`
    )
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add panels to view…', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Add panel', exact: true })
  await expect(picker).toBeVisible()
  for (const title of ['App shell', 'Test shell', 'API shell', 'Architecture.md', 'Review shell']) {
    await expect(picker.getByRole('option').filter({ hasText: title })).toBeVisible()
  }
  await page.evaluate(() => {
    const state = window.__store!.getState()
    if (state.activeWorkspaceViewId) {
      state.renameWorkspaceView(state.activeWorkspaceViewId, 'Across projects')
    }
  })
  await page.screenshot({ path: testInfo.outputPath('project-picker.png') })
  for (const title of ['App shell', 'Test shell', 'API shell', 'Architecture.md']) {
    await picker.getByRole('option').filter({ hasText: title }).click()
  }
  await picker.getByRole('button', { name: 'Add selected panels', exact: true }).click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(4)

  const terminals = [
    { ...app, project: storefront, marker: 'STOREFRONT_APP' },
    { ...tests, project: storefront, marker: 'STOREFRONT_TESTS' },
    { ...api, project: payments, marker: 'PAYMENTS_API' }
  ]
  for (const terminal of terminals) {
    await expect(panel(page, terminal.title)).toContainText(terminal.project.name)
    await panel(page, terminal.title).locator('[data-workspace-view-panel-header]').click()
    await page.keyboard.type(
      `printf '${terminal.marker}' > .view-${terminal.marker}; printf '\\033[2J\\033[HPROJECT: '; cat PROJECT_ID; printf '\\nWORKING DIRECTORY:\\n'; pwd; printf '\\nGIT ROOT:\\n'; git rev-parse --show-toplevel; printf '\\nSESSION: '; cat .view-${terminal.marker}; printf '\\n'`
    )
    await page.keyboard.press('Enter')
    await expect
      .poll(
        () =>
          existsSync(path.join(terminal.project.directory, `.view-${terminal.marker}`)) &&
          readFileSync(path.join(terminal.project.directory, `.view-${terminal.marker}`), 'utf8')
      )
      .toBe(terminal.marker)
    for (const other of projects.filter((p) => p.repoId !== terminal.project.repoId)) {
      expect(existsSync(path.join(other.directory, `.view-${terminal.marker}`))).toBe(false)
    }
    await expect
      .poll(() => page.evaluate(() => window.__store!.getState().activeWorktreeId))
      .toBe(terminal.project.workspaceId)
  }
  await expect(panel(page, 'Architecture.md')).toContainText('Documentation')
  for (const terminal of terminals) {
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            window.__paneManagers?.get(id)?.getActivePane()?.serializeAddon?.serialize() ?? '',
          terminal.tabId
        )
      )
      .toContain(`SESSION: ${terminal.marker}`)
    for (const other of terminals.filter((t) => t.tabId !== terminal.tabId)) {
      expect(
        await page.evaluate(
          (id) =>
            window.__paneManagers?.get(id)?.getActivePane()?.serializeAddon?.serialize() ?? '',
          other.tabId
        )
      ).not.toContain(`SESSION: ${terminal.marker}`)
    }
  }
  await expect(panel(page, 'Architecture.md').locator('.rich-markdown-editor')).toContainText(
    'Documentation project'
  )
  const ownership = await page.evaluate(() => {
    const state = window.__store!.getState()
    const view = state.workspaceViews.find((view) => view.id === state.activeWorkspaceViewId)!
    return view.panels.map((p) => {
      const workspace = Object.values(state.worktreesByRepo)
        .flat()
        .find((w) => w.id === p.workspaceId)!
      return {
        panelId: p.id,
        tabId: p.tabId,
        workspaceId: workspace.id,
        repoId: workspace.repoId,
        path: workspace.path,
        project: p.projectName
      }
    })
  })
  expect(new Set(ownership.map((p) => p.repoId))).toEqual(new Set(projects.map((p) => p.repoId)))
  await page.screenshot({ path: testInfo.outputPath('three-projects-with-navigation.png') })
  await page.getByRole('button', { name: 'Fill window', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('three-projects-full-window.png') })

  await page.getByRole('button', { name: 'Add panel', exact: true }).click()
  await page.getByRole('option').filter({ hasText: 'Review shell' }).click()
  await page.getByRole('button', { name: 'Add selected panels', exact: true }).click()
  await expect(page.locator('[data-workspace-view-panel-id]')).toHaveCount(5)
  await expect(panel(page, 'Review shell')).toContainText('review')
  await panel(page, 'Review shell').locator('[data-workspace-view-panel-header]').click()
  await page.keyboard.type(
    "printf REVIEW_WORKTREE > .view-review; printf '\\033[2J\\033[HWORKTREE: review\\n'; pwd; printf '\\nSHARED GIT DIRECTORY:\\n'; git rev-parse --path-format=absolute --git-common-dir"
  )
  await page.keyboard.press('Enter')
  await expect
    .poll(
      () =>
        existsSync(path.join(worktreePath, '.view-review')) &&
        readFileSync(path.join(worktreePath, '.view-review'), 'utf8')
    )
    .toBe('REVIEW_WORKTREE')
  expect(existsSync(path.join(storefront.directory, '.view-review'))).toBe(false)
  for (const terminal of [...terminals, review]) {
    expect(
      await page.evaluate(
        (id) => window.__paneManagers?.get(id)?.getActivePane()?.container.dataset.ptyId,
        terminal.tabId
      )
    ).toBe(terminal.ptyId)
  }
  await page.screenshot({ path: testInfo.outputPath('three-projects-and-worktree.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible())
    )
  ).toBe(true)
  expect(errors).toEqual([])
  writeFileSync(
    testInfo.outputPath('project-ownership.json'),
    JSON.stringify(
      {
        projects,
        ownership,
        terminals: terminals.map(({ tabId, ptyId, title, project }) => ({
          tabId,
          ptyId,
          title,
          projectId: project.repoId
        })),
        reviewWorkspace,
        worktreePath
      },
      null,
      2
    )
  )
})
