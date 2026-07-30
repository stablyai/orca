import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page, TestInfo } from '@playwright/test'

const STASH_ROWS = [
  'stash',
  'stash_include_untracked',
  'stash_pop_latest',
  'stash_pop_pick',
  'stash_apply_latest',
  'stash_apply_pick',
  'stash_drop_pick',
  'stash_drop_all'
] as const

async function openSourceControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__store?.getState().setRightSidebarOpen(true)
  })
  await page.getByRole('button', { name: /Source Control/ }).click()
}

/**
 * Modify a file that is already committed, so the tree has a genuinely *tracked*
 * change. A newly created file would be untracked, which plain `git stash` does
 * not save — the two cases drive different rows.
 */
async function seedTrackedChange(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('active worktree not found')
    }
    const separator = worktree.path.includes('\\') ? '\\' : '/'
    // README.md is committed by the e2e repo seeder, so editing it yields a
    // tracked modification rather than a new untracked file.
    const fileName = 'README.md'
    const filePath = `${worktree.path}${separator}${fileName}`
    const existing = await window.api.fs.readFile({ filePath })
    await window.api.fs.writeFile({
      filePath,
      content: `${existing.content}\nstash me ${Date.now()}\n`
    })
    const status = await window.api.git.status({ worktreePath: worktree.path })
    state.setGitStatus(worktree.id, status)
    return fileName
  })
}

/** Create a brand-new file — untracked, so only include-untracked can stash it. */
async function seedUntrackedFile(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.__store
    const state = store?.getState()
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === state?.activeWorktreeId)
    if (!state || !worktree) {
      throw new Error('active worktree not found')
    }
    const separator = worktree.path.includes('\\') ? '\\' : '/'
    const fileName = `orca-stash-untracked-${Date.now()}.txt`
    await window.api.fs.writeFile({
      filePath: `${worktree.path}${separator}${fileName}`,
      content: 'untracked\n'
    })
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
    return fileName
  })
}

/**
 * Undo only what this spec created. The seeded repo is shared, so discarding
 * every entry would delete files another spec is mid-assertion on.
 */
async function cleanupSeeded(page: Page, relativePaths: string[]): Promise<void> {
  await page.evaluate(async (paths) => {
    const store = window.__store
    const state = store?.getState()
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === state?.activeWorktreeId)
    if (!state || !worktree) {
      return
    }
    // Drop any stash this spec left behind before restoring the files, so a
    // failed pop cannot leak an entry into the next run.
    await window.api.git.stashClear({ worktreePath: worktree.path }).catch(() => {})
    for (const relativePath of paths) {
      await window.api.git
        .discard({ worktreePath: worktree.path, filePath: relativePath })
        .catch(() => {})
    }
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
  }, relativePaths)
}

async function refreshGitStatus(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    const state = store?.getState()
    const worktree = Object.values(state?.worktreesByRepo ?? {})
      .flat()
      .find((entry) => entry.id === state?.activeWorktreeId)
    if (!state || !worktree) {
      return
    }
    state.setGitStatus(worktree.id, await window.api.git.status({ worktreePath: worktree.path }))
  })
}

/**
 * Wait for a seeded file to show up in the panel, re-refreshing each attempt.
 *
 * Why: seeding writes the file then pushes one status snapshot, but a poll that
 * started before the write can resolve afterwards and overwrite it with a stale
 * clean status. A single assertion would then wait out the timeout.
 */
async function waitForEntry(page: Page, fileName: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await refreshGitStatus(page)
        return page.getByTestId('source-control-entry').filter({ hasText: fileName }).count()
      },
      { timeout: 20_000 }
    )
    .toBeGreaterThan(0)
}

async function openStashSubmenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'More commit and remote actions' }).click()
  // Click rather than hover: hover hit-testing on a submenu trigger is the
  // flakiest part of a Radix menu in CI.
  await page.getByTestId('source-control-stash-submenu-trigger').click()
  await expect(page.getByTestId('source-control-dropdown-stash')).toBeVisible()
}

async function closeMenus(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('source-control-dropdown-stash')).toBeHidden()
}

async function attachSubmenuScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  // Scope to the submenu so the artifact is a tight, stable crop.
  const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]').first()
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await submenu.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

// Why: these specs mutate the shared seeded repo, so they must not overlap with
// each other — a parallel sibling's cleanup would delete files mid-assertion.
test.describe.configure({ mode: 'serial' })

test.describe('Source Control stash actions', () => {
  const seeded: string[] = []

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  // Why: failure-safe — runs even when an assertion throws, so a leftover dirty
  // tree or stash never leaks into a later spec.
  test.afterEach(async ({ orcaPage }) => {
    await cleanupSeeded(orcaPage, seeded.splice(0))
  })

  test('exposes all eight stash actions with the right enabled state', async ({
    orcaPage
  }, testInfo) => {
    seeded.push(await seedTrackedChange(orcaPage))
    await openSourceControl(orcaPage)
    await openStashSubmenu(orcaPage)

    for (const kind of STASH_ROWS) {
      await expect(orcaPage.getByTestId(`source-control-dropdown-${kind}`)).toBeVisible()
    }

    // A dirty tree can stash; an empty stash list cannot be restored from.
    await expect(orcaPage.getByTestId('source-control-dropdown-stash')).toBeEnabled()
    await expect(
      orcaPage.getByTestId('source-control-dropdown-stash_include_untracked')
    ).toBeEnabled()
    await expect(orcaPage.getByTestId('source-control-dropdown-stash_pop_latest')).toBeDisabled()
    await expect(orcaPage.getByTestId('source-control-dropdown-stash_drop_all')).toBeDisabled()

    await attachSubmenuScreenshot(orcaPage, testInfo, 'stash-submenu')
    await closeMenus(orcaPage)
  })

  test('offers only include-untracked when nothing tracked has changed', async ({ orcaPage }) => {
    // Why: plain `git stash` exits 0 with "No local changes to save" here, so an
    // enabled Stash row would be a confusing no-op.
    const fileName = await seedUntrackedFile(orcaPage)
    seeded.push(fileName)
    await openSourceControl(orcaPage)
    // Why: the rows are resolved from the panel's status, so the seeded file has
    // to be visible before opening the menu or both stash rows read
    // "Nothing to stash".
    await waitForEntry(orcaPage, fileName)
    await openStashSubmenu(orcaPage)

    await expect(orcaPage.getByTestId('source-control-dropdown-stash')).toBeDisabled()
    await expect(
      orcaPage.getByTestId('source-control-dropdown-stash_include_untracked')
    ).toBeEnabled()

    await closeMenus(orcaPage)
  })

  test('cancelling the name prompt leaves the working tree untouched', async ({ orcaPage }) => {
    const fileName = await seedUntrackedFile(orcaPage)
    seeded.push(fileName)
    await openSourceControl(orcaPage)
    await waitForEntry(orcaPage, fileName)
    const entry = orcaPage.getByTestId('source-control-entry').filter({ hasText: fileName })

    await openStashSubmenu(orcaPage)
    await orcaPage.getByTestId('source-control-dropdown-stash_include_untracked').click()
    await expect(orcaPage.getByTestId('source-control-stash-message-input')).toBeVisible()
    await orcaPage.keyboard.press('Escape')

    // Why: cancel must abort the stash, not stash with an empty name.
    await expect(orcaPage.getByTestId('source-control-stash-message-input')).toBeHidden()
    await refreshGitStatus(orcaPage)
    await expect(entry).toBeVisible()
  })

  test('stashes changes and pops them back', async ({ orcaPage }) => {
    const fileName = await seedUntrackedFile(orcaPage)
    seeded.push(fileName)
    await openSourceControl(orcaPage)

    await waitForEntry(orcaPage, fileName)
    const entry = orcaPage.getByTestId('source-control-entry').filter({ hasText: fileName })

    await openStashSubmenu(orcaPage)
    await orcaPage.getByTestId('source-control-dropdown-stash_include_untracked').click()

    // Naming is prompted for; type one so the picker has something to show.
    const nameInput = orcaPage.getByTestId('source-control-stash-message-input')
    await expect(nameInput).toBeVisible()
    await nameInput.fill('e2e parked work')
    await orcaPage.getByTestId('source-control-stash-message-confirm').click()

    // The file leaves the working tree, so its row leaves the list.
    await expect(entry).toBeHidden()

    await openStashSubmenu(orcaPage)
    const popLatest = orcaPage.getByTestId('source-control-dropdown-stash_pop_latest')
    await expect(popLatest).toBeEnabled()
    await expect(popLatest).toContainText('Pop Latest Stash (1)')
    await popLatest.click()

    await refreshGitStatus(orcaPage)
    await expect(entry).toBeVisible()

    // Leave no stash behind for the next spec sharing this repo.
    await openStashSubmenu(orcaPage)
    await expect(orcaPage.getByTestId('source-control-dropdown-stash_pop_latest')).toBeDisabled()
    await closeMenus(orcaPage)
  })
})
