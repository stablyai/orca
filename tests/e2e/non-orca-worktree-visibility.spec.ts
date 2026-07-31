import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

const GUIDED_ROW_ATTRIBUTE = 'data-guided-actions'
const PROJECT_ACTIONS_TRIGGER_ATTRIBUTE = 'data-project-actions-trigger'
const PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE = 'data-project-actions-visibility-item'

// Fixture and project-add flow adapted from the spec in #11275.
const SCRATCH_NAME = 'processing-lock'
const SCRATCH_RELATIVE_PATH = `.claude/worktrees/${SCRATCH_NAME}`
const EXTERNAL_BRANCH = 'payments-refactor'

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

async function createFixture(
  registerPostElectronShutdownCleanup: (cleanup: () => Promise<void>) => void
): Promise<{ mainPath: string; scratchPath: string; externalPath: string }> {
  const rootPath = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'orca-non-orca-visibility-')))
  // Why: the fixture holds watched worktrees; removing it before Electron exits
  // fails with EPERM on Windows.
  registerPostElectronShutdownCleanup(async () => {
    rmSync(rootPath, { recursive: true, force: true })
  })

  const mainPath = path.join(rootPath, 'orca')
  mkdirSync(mainPath, { recursive: true })
  git(mainPath, ['init'])
  git(mainPath, ['config', 'user.email', 'e2e@test.local'])
  git(mainPath, ['config', 'user.name', 'E2E Test'])
  // Why: a contributor signing commits globally would otherwise need a key here.
  git(mainPath, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(path.join(mainPath, 'README.md'), '# orca\n')
  git(mainPath, ['add', 'README.md'])
  git(mainPath, ['commit', '-m', 'Initial commit'])
  git(mainPath, ['branch', '-M', 'main'])

  const externalPath = path.join(rootPath, 'worktrees', EXTERNAL_BRANCH)
  git(mainPath, ['worktree', 'add', '-b', EXTERNAL_BRANCH, externalPath])

  // Why: sitting under a registered checkout is what makes this agent scratch
  // rather than other, the kind the non-Orca setting must never reveal (#9388).
  const scratchPath = path.join(mainPath, '.claude', 'worktrees', SCRATCH_NAME)
  git(mainPath, ['worktree', 'add', '-b', `fix/${SCRATCH_NAME}`, scratchPath])

  return { mainPath, scratchPath, externalPath }
}

async function addProject(orcaPage: Page, mainPath: string): Promise<string> {
  await orcaPage.evaluate((folderPath) => {
    window.__store?.getState().openModal('confirm-add-project-from-folder', { folderPath })
  }, mainPath)
  const addProjectDialog = orcaPage.getByRole('dialog', { name: /^Add Project$/i })
  await expect(addProjectDialog).toBeVisible()
  await addProjectDialog.getByRole('button', { name: /^Add Project$/ }).click()
  await expect(addProjectDialog).toBeHidden()

  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (repoPath) =>
            window.__store?.getState().repos.find((repo) => repo.path === repoPath)?.id ?? null,
          mainPath
        ),
      { timeout: 30_000, message: 'project was not added' }
    )
    .not.toBeNull()

  return orcaPage.evaluate(
    (repoPath) => window.__store?.getState().repos.find((repo) => repo.path === repoPath)?.id ?? '',
    mainPath
  )
}

async function setExternalVisibility(
  orcaPage: Page,
  repoId: string,
  externalWorktreeVisibility: 'show' | 'hide'
): Promise<void> {
  await orcaPage.evaluate(
    async ({ repoId: id, externalWorktreeVisibility: visibility }) => {
      await window.__store?.getState().updateRepo(id, { externalWorktreeVisibility: visibility })
      await window.__store?.getState().fetchWorktrees(id, { requireAuthoritative: true })
    },
    { repoId, externalWorktreeVisibility }
  )
}

function section(dialog: Locator, title: string): Locator {
  return dialog
    .locator('section')
    .filter({ has: dialog.page().getByRole('heading', { name: title }) })
}

async function openIndividualList(kindSection: Locator): Promise<Locator> {
  await kindSection.getByRole('button', { name: /^Manage individually/ }).click()
  return kindSection.getByRole('listitem')
}

test.describe('Non-Orca worktree visibility', () => {
  test('recovers an agent worktree the non-Orca setting cannot reveal, then hides it again', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    await waitForSessionReady(orcaPage)

    // Why: a fresh E2E profile follows the host locale, and this spec matches on
    // English control names.
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })
    await expect(orcaPage.getByRole('button', { name: /Automations/i }).first()).toBeVisible()

    const fixture = await createFixture(registerPostElectronShutdownCleanup)
    const repoId = await addProject(orcaPage, fixture.mainPath)

    const scratchRow = worktreeRow(orcaPage, `${repoId}::${fixture.scratchPath}`)
    const externalRow = worktreeRow(orcaPage, `${repoId}::${fixture.externalPath}`)

    // Why: #9388 — showing every other non-Orca worktree must still leave agent
    // worktrees hidden.
    await setExternalVisibility(orcaPage, repoId, 'show')
    await expect(externalRow).toHaveCount(1)
    await expect(scratchRow).toHaveCount(0)

    await setExternalVisibility(orcaPage, repoId, 'hide')
    await expect(externalRow).toHaveCount(0)
    await expect(scratchRow).toHaveCount(0)

    await orcaPage.evaluate((id) => {
      window.__store?.getState().openModal('worktree-visibility', { repoId: id })
    }, repoId)
    const dialog = orcaPage.getByRole('dialog', { name: /Non-Orca worktrees/i })
    await expect(dialog).toBeVisible()

    const agentSection = section(dialog, 'Agent scratch worktrees')
    const agentRows = await openIndividualList(agentSection)
    const scratchListRow = agentRows.filter({ hasText: SCRATCH_RELATIVE_PATH })
    await expect(scratchListRow).toHaveCount(1)

    await scratchListRow.getByRole('button', { name: /in the sidebar$/ }).click()
    await expect(scratchRow).toHaveCount(1)
    // Why: showing one worktree is an exception, not a disguised repo-wide switch.
    await expect(externalRow).toHaveCount(0)

    // Why: the exception outranks the switch, so hiding the whole kind has to drop
    // it as well or the row would survive the switch that was just set.
    await agentSection.getByRole('button', { name: /^Hide all$/ }).click()
    await expect(scratchRow).toHaveCount(0)
  })

  test('reveals the hidden project actions button from the sidebar notice', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
    })
    await expect(orcaPage.getByRole('button', { name: /Automations/i }).first()).toBeVisible()

    const fixture = await createFixture(registerPostElectronShutdownCleanup)
    const repoId = await addProject(orcaPage, fixture.mainPath)

    // Why: the inbox only speaks once the first-run question is answered and the kind
    // is hidden, which is the state where the notice points at the hidden menu.
    await orcaPage.evaluate(async (id) => {
      await window.__store?.getState().updateRepo(id, {
        externalWorktreeVisibility: 'hide',
        externalWorktreeVisibilityPromptDismissedAt: Date.now()
      })
      await window.__store?.getState().fetchWorktrees(id, { requireAuthoritative: true })
    }, repoId)

    const notice = orcaPage.locator('section', {
      has: orcaPage.getByText('New externally-created worktrees')
    })
    await expect(notice).toHaveCount(1)
    await notice.getByRole('button', { name: /^Expand new externally-created worktrees/ }).click()

    const trigger = orcaPage.locator(`[${PROJECT_ACTIONS_TRIGGER_ATTRIBUTE}="${repoId}"]`)
    // Why: the actions cluster is width/opacity-hidden until hover, so Playwright sees
    // a zero-size box and reports it hidden.
    await expect(trigger).toBeHidden()

    await notice
      .getByRole('button', { name: /^here$/ })
      .click()

    await expect(orcaPage.locator(`[${GUIDED_ROW_ATTRIBUTE}]`)).toHaveCount(1)
    await expect(trigger).toBeVisible()
    // Why: Playwright visibility ignores opacity, so assert real paint on the button and
    // on the cluster wrapper above it, which is the ancestor that hides them on desktop.
    await expect(trigger).toHaveCSS('opacity', '1')
    await expect(
      orcaPage.locator(`[${GUIDED_ROW_ATTRIBUTE}] [data-repo-header-actions]`)
    ).toHaveCSS('opacity', '1')
    const item = orcaPage.locator(`[${PROJECT_ACTIONS_VISIBILITY_ITEM_ATTRIBUTE}]`)
    await expect(item).toBeVisible()
    await expect(item).toBeFocused()
  })
})
