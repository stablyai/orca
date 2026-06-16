import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

const tempRoots: string[] = []
const SORTABLE_TAB = '[data-testid="sortable-tab"]'
const REPO_STEP_HEADING = /Point Orca at some code/i
const TASK_SOURCES_HEADING = /Set up GitHub tasks|Connect your task sources/i
const WINDOWS_TERMINAL_HEADING = /Set Windows terminal defaults/i
const ONBOARDING_ADVANCE_LABEL = /^Continue\b|^Add your first project\b/
test.describe.configure({ mode: 'serial' })
test.afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function createGitRepo(prefix: string, name: string): Promise<string> {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempRoots.push(rootPath)
  const repoPath = path.join(rootPath, name)

  mkdirSync(repoPath, { recursive: true })
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], {
    cwd: repoPath,
    stdio: 'pipe'
  })
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
function onboardingFooter(page: Page) {
  return page
    .locator('footer')
    .filter({
      has: page.getByRole('button', { name: /Back|Continue|Add your first project|Skip/i })
    })
    .first()
}

async function continueOnboarding(page: Page): Promise<void> {
  await onboardingFooter(page).getByRole('button', { name: ONBOARDING_ADVANCE_LABEL }).click()
}

async function selectCodexAgent(page: Page): Promise<void> {
  const codexButton = page.getByRole('button', { name: /^Codex\s/ })
  const codexVisible = await codexButton
    .first()
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (!codexVisible) {
    await page.getByText(/Show \d+ more agents/).click()
  }
  await codexButton.first().click()
  await expect(codexButton.first()).toHaveAttribute('aria-pressed', 'true')
}

async function chooseOppositeTheme(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.documentElement.classList.contains('dark') ||
      document.documentElement.classList.contains('light')
  )
  const startingTheme = await page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )
  const nextTheme = startingTheme === 'dark' ? 'light' : 'dark'
  const tileName = nextTheme === 'light' ? /Bright & crisp/ : /Easy on the eyes/
  await page.getByRole('button', { name: tileName }).click()
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.documentElement.classList.contains('dark') ? 'dark' : 'light'
        ),
      { timeout: 5_000 }
    )
    .toBe(nextTheme)
}

async function chooseNotificationSound(page: Page): Promise<void> {
  const soundSelect = page.getByRole('combobox').first()
  await expect(soundSelect).toContainText(/System Default/i)
  await soundSelect.click()
  const dingOption = page.getByRole('option', { name: /^Ding$/i })
  await expect(dingOption).toBeVisible()
  await dingOption.press('Enter')
  await expect(soundSelect).toContainText(/Ding/i)
}

async function continueThroughOptionalSetupToNotifications(page: Page): Promise<void> {
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await continueOnboarding(page)
  }
  const windowsTerminalVisible = await page
    .getByRole('heading', { name: WINDOWS_TERMINAL_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (windowsTerminalVisible) {
    await continueOnboarding(page)
  }
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
}

async function continueFromNotificationsToRepo(page: Page): Promise<void> {
  await continueOnboarding(page)
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await continueOnboarding(page)
  }
  const windowsTerminalVisible = await page
    .getByRole('heading', { name: WINDOWS_TERMINAL_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (windowsTerminalVisible) {
    await continueOnboarding(page)
  }
  const repoHeading = page.getByRole('heading', { name: REPO_STEP_HEADING })
  const addProjectDialog = page.getByRole('dialog', { name: /Add a project/i })
  await expect
    .poll(
      async () => {
        if (await repoHeading.isVisible().catch(() => false)) {
          return 'repo-step'
        }
        if (await addProjectDialog.isVisible().catch(() => false)) {
          return 'add-project-dialog'
        }
        return 'waiting'
      },
      { timeout: 15_000 }
    )
    .not.toBe('waiting')
}

async function waitForRepoLoaded(page: Page, repoPath: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPath) => {
          const state = window.__store?.getState()
          const repo = state?.repos.find((candidate) => candidate.path === targetPath)
          if (!state || !repo) {
            return false
          }
          return (state.worktreesByRepo[repo.id] ?? []).length > 0
        }, repoPath),
      { timeout: 30_000, message: `repo did not load: ${repoPath}` }
    )
    .toBe(true)
}

async function expectProjectVisible(page: Page, repoPath: string): Promise<void> {
  const repoName = path.basename(repoPath)
  await expect(page.getByText(repoName, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
}

async function addProjectFromSidebar(
  page: Page,
  electronApp: ElectronApplication,
  repoPath: string
): Promise<void> {
  await chooseFolderInNativeDialog(electronApp, repoPath)
  await page
    .getByRole('button', { name: /Add Project/i })
    .first()
    .click()
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

  await waitForRepoLoaded(page, repoPath)
  await expectProjectVisible(page, repoPath)
}

async function createWorkspace(page: Page, workspaceName: string): Promise<void> {
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  const nameInput = dialog.getByPlaceholder(/Type a name/i)
  await expect(nameInput).toBeVisible()
  await nameInput.fill(workspaceName)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
  await expectActiveWorkspaceVisible(page, workspaceName)
}

async function expectActiveWorkspaceBelongsToRepo(
  page: Page,
  workspaceName: string,
  repoPath: string
): Promise<void> {
  await expectActiveWorkspaceVisible(page, workspaceName)
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ targetRepoPath, targetWorkspaceName }) => {
            const state = window.__store?.getState()
            if (!state?.activeWorktreeId) {
              return null
            }
            const repo = state.repos.find((candidate) => candidate.path === targetRepoPath)
            if (!repo) {
              return null
            }
            const activeWorktree = (state.worktreesByRepo[repo.id] ?? []).find(
              (worktree) => worktree.id === state.activeWorktreeId
            )
            return activeWorktree?.displayName === targetWorkspaceName
          },
          { targetRepoPath: repoPath, targetWorkspaceName: workspaceName }
        ),
      { timeout: 20_000, message: 'active workspace did not belong to the newly added project' }
    )
    .toBe(true)
}

async function expectActiveWorkspaceVisible(page: Page, workspaceName: string): Promise<void> {
  const activeWorkspace = page
    .locator('[role="option"][aria-current="page"]')
    .filter({ hasText: new RegExp(escapeRegExp(workspaceName)) })
    .first()
  await expect(activeWorkspace).toBeVisible({ timeout: 20_000 })
}

async function countRenderedTabs(page: Page): Promise<number> {
  return page.locator(SORTABLE_TAB).count()
}

async function renderedTabIds(page: Page): Promise<string[]> {
  return page.locator(SORTABLE_TAB).evaluateAll((tabs) =>
    tabs.flatMap((tab) => {
      const tabId = tab.getAttribute('data-tab-id')
      return tabId ? [tabId] : []
    })
  )
}

async function expectTerminalSurface(page: Page): Promise<void> {
  await expect
    .poll(() => page.locator('[data-terminal-tab-id]').count(), { timeout: 30_000 })
    .toBeGreaterThan(0)
  const terminalSurface = page.locator('[data-terminal-tab-id]').first()
  await expect(terminalSurface).toHaveAttribute('data-native-file-drop-target', 'terminal')
}

async function waitForTerminalPaneManager(page: Page): Promise<void> {
  await waitForPaneCount(page, 1, 30_000)
  await waitForActiveTerminalManager(page, 30_000)
}

async function createTerminalTabThroughMenu(page: Page): Promise<void> {
  const tabIdsBefore = await renderedTabIds(page)
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  const newTerminalMenuItem = page.getByRole('menuitem', { name: /New Terminal/i }).first()
  await newTerminalMenuItem.click({ force: true })
  await expect.poll(() => countRenderedTabs(page), { timeout: 5_000 }).toBe(tabIdsBefore.length + 1)
  const createdTabIds = (await renderedTabIds(page)).filter(
    (tabId) => !tabIdsBefore.includes(tabId)
  )
  expect(createdTabIds, 'new terminal tab should render exactly one new tab').toHaveLength(1)
  const createdTab = page.locator(`${SORTABLE_TAB}[data-tab-id="${createdTabIds[0]}"]`).first()
  await expect(createdTab).toHaveAttribute('data-tab-title', /.+/)
  await expectTerminalSurface(page)
}

async function splitTerminalPaneAndAssertIdentity(page: Page): Promise<void> {
  const paneCountBefore = await countVisibleTerminalPanes(page)
  await splitActiveTerminalPane(page, 'vertical')
  await waitForPaneCount(page, paneCountBefore + 1)
  const snapshot = await waitForPaneIdentitySnapshot(page, paneCountBefore + 1)
  expect(snapshot.panes).toHaveLength(paneCountBefore + 1)
}

async function requestAgentSessionsTour(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          const splitTarget = document.querySelector(
            '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
          )
          const rect = splitTarget?.getBoundingClientRect()
          return {
            ready: state?.persistedUIReady === true,
            onboardingHidden: state?.contextualToursOnboardingVisible === false,
            noModal: state?.activeModal === 'none',
            splitTargetMeasurable: Boolean(rect && rect.width > 0 && rect.height > 0)
          }
        }),
      { timeout: 30_000 }
    )
    .toEqual({
      ready: true,
      onboardingHidden: true,
      noModal: true,
      splitTargetMeasurable: true
    })

  await page.evaluate(() => {
    window.__store
      ?.getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })
  })
  await expect(page.getByRole('dialog', { name: /Split a terminal pane/i })).toBeVisible()
}

async function completeWorkspaceCreationTour(page: Page, workspaceName: string): Promise<void> {
  const pickProjectStep = page.getByRole('dialog', { name: /Pick a project/i })
  await expect(pickProjectStep).toBeVisible()
  // Why: the project picker can leave its command popover open after the tour
  // starts. Keyboard-activate the step button so the golden verifies the tour
  // transition instead of pointer geometry around that popover.
  await pickProjectStep.getByRole('button', { name: /^Next$/ }).focus()
  await page.keyboard.press('Enter')
  const nameStep = page.getByRole('dialog', { name: /Name it, or start from existing work/i })
  await expect(nameStep).toBeVisible()
  const autoNameSwitch = nameStep.getByRole('switch', {
    name: /Auto-name workspace from first agent message/i
  })
  const checkedBefore = await autoNameSwitch.getAttribute('aria-checked')
  await autoNameSwitch.click()
  await expect(autoNameSwitch).toHaveAttribute(
    'aria-checked',
    checkedBefore === 'true' ? 'false' : 'true'
  )
  await page.getByRole('button', { name: /^Next$/ }).click()
  await expect(
    page.getByRole('dialog', { name: /Choose what agent starts the work/i })
  ).toBeVisible()
  await page.getByRole('button', { name: /^Done$/ }).click()

  const composer = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(composer).toBeVisible()
  await composer.getByPlaceholder(/Type a name/i).fill(workspaceName)
  await composer.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(composer).toBeHidden({ timeout: 20_000 })
  await expectActiveWorkspaceVisible(page, workspaceName)
}

test.describe('Existing-user golden core flow', () => {
  test('adds project, creates workspace, opens a terminal tab, and splits a pane', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const repoPath = await createGitRepo('orca-e2e-golden-existing-', 'golden-existing-project')

    await addProjectFromSidebar(orcaPage, electronApp, repoPath)
    const workspaceName = `golden-existing-${Date.now()}`
    await createWorkspace(orcaPage, workspaceName)
    await expectActiveWorkspaceBelongsToRepo(orcaPage, workspaceName, repoPath)
    await ensureTerminalVisible(orcaPage)
    await expectTerminalSurface(orcaPage)
    await waitForTerminalPaneManager(orcaPage)

    await createTerminalTabThroughMenu(orcaPage)
    await splitTerminalPaneAndAssertIdentity(orcaPage)
  })
})

test.describe('New-user golden core flow', () => {
  test.use({ dismissOnboarding: false, seedTestRepo: false })

  test('completes onboarding, adds a project, and follows the workspace tour handoff', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    await selectCodexAgent(orcaPage)
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await chooseOppositeTheme(orcaPage)
    await continueOnboarding(orcaPage)
    await continueThroughOptionalSetupToNotifications(orcaPage)
    await expect(orcaPage.getByRole('button', { name: /Send Test Notification/i })).toBeVisible()
    await chooseNotificationSound(orcaPage)
    await continueFromNotificationsToRepo(orcaPage)

    const repoPath = await createGitRepo('orca-e2e-golden-new-', 'golden-new-project')
    await chooseFolderInNativeDialog(electronApp, repoPath)
    await orcaPage
      .getByRole('button', { name: /Browse for a folder|Open a folder|Browse folder/i })
      .click()
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toHaveCount(0, {
      timeout: 30_000
    })
    await waitForRepoLoaded(orcaPage, repoPath)
    await expectProjectVisible(orcaPage, repoPath)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await expectTerminalSurface(orcaPage)
    await waitForTerminalPaneManager(orcaPage)

    await requestAgentSessionsTour(orcaPage)
    const paneCountBeforeTourSplit = await countVisibleTerminalPanes(orcaPage)
    await orcaPage.getByRole('button', { name: /^Split terminal$/ }).click()
    await waitForPaneCount(orcaPage, paneCountBeforeTourSplit + 1)
    await waitForPaneIdentitySnapshot(orcaPage, paneCountBeforeTourSplit + 1)

    await expect(
      orcaPage.getByRole('dialog', { name: /Start another task in parallel/i })
    ).toBeVisible()
    const createControl = orcaPage
      .locator('[data-contextual-tour-target="workspace-create-control"]')
      .first()
    await expect(createControl).toBeVisible()
    await expect(createControl).toHaveAttribute('aria-label', 'New workspace')
    const createControlBox = await createControl.boundingBox()
    expect(createControlBox?.width ?? 0).toBeGreaterThan(0)
    expect(createControlBox?.height ?? 0).toBeGreaterThan(0)
    await createControl.click()

    const workspaceName = `golden-new-${Date.now()}`
    await completeWorkspaceCreationTour(orcaPage, workspaceName)
    await expectActiveWorkspaceBelongsToRepo(orcaPage, workspaceName, repoPath)
  })
})
