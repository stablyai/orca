/**
 * Coverage for the per-project default browser session profile added to the
 * repository settings pane. Verifies the selector persists onto the repo record
 * and that a new browser tab in that project actually opens on the chosen
 * profile instead of the app-wide default.
 */
import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getStoreState, waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import type { BrowserSessionProfile, Repo } from '../../src/shared/types'

const PROFILE_LABEL = 'E2E Project Profile'

/** Opens the repo settings panel and pins the UI language to English. */
async function openRepoSettings(page: Page, repoId: string): Promise<void> {
  // Why: the host OS locale (e.g. ko-KR) drives Orca's default UI language.
  await page.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
  await page.evaluate((repoId) => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'repo', repoId })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLaterButton.click()
  }
}

async function attachScreenshot(
  target: Page | Locator,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await target.screenshot({ path: screenshotPath })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Per-project browser profile', () => {
  test('selecting a project profile routes new browser tabs to it', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    const repos = await getStoreState<Repo[]>(orcaPage, 'repos')
    expect(repos.length).toBeGreaterThan(0)
    const repo = repos[0]

    const profile = await orcaPage.evaluate(
      async (label) =>
        (await window
          .__store!.getState()
          .createBrowserSessionProfile('isolated', label)) as BrowserSessionProfile | null,
      PROFILE_LABEL
    )
    expect(profile?.id).toBeTruthy()
    const profileId = profile!.id

    // Baseline: with no override, a new tab inherits the app-wide default (none set here).
    const inheritedTab = await orcaPage.evaluate(
      (worktreeId) =>
        window.__store!.getState().createBrowserTab(worktreeId, 'about:blank', { activate: false })
          .sessionProfileId,
      worktreeId
    )
    expect(inheritedTab).toBeNull()

    await openRepoSettings(orcaPage, repo.id)

    const section = orcaPage.locator(`[id="repo-browser-profile-${repo.id}"]`)
    await expect(section).toBeVisible({ timeout: 10_000 })
    await expect(section.getByText('Browser Profile').first()).toBeVisible()

    await section.scrollIntoViewIfNeeded()
    const trigger = section.getByRole('combobox')
    await expect(trigger).toHaveText('Use app default')
    await attachScreenshot(section, testInfo, 'repository-browser-profile-default')

    await trigger.click()
    await orcaPage.getByRole('option', { name: PROFILE_LABEL }).click()

    await expect
      .poll(
        async () => {
          const current = await getStoreState<Repo[]>(orcaPage, 'repos')
          return current.find((entry) => entry.id === repo.id)?.defaultBrowserSessionProfileId
        },
        { timeout: 10_000, message: 'project browser profile did not persist' }
      )
      .toBe(profileId)

    await expect(trigger).toHaveText(PROFILE_LABEL)
    await attachScreenshot(section, testInfo, 'repository-browser-profile-selected')
    await attachScreenshot(orcaPage, testInfo, 'repository-browser-profile-pane')

    // The store round-trip alone would pass even if new tabs ignored the override.
    const overriddenTab = await orcaPage.evaluate(
      (worktreeId) =>
        window.__store!.getState().createBrowserTab(worktreeId, 'about:blank', { activate: false })
          .sessionProfileId,
      worktreeId
    )
    expect(overriddenTab).toBe(profileId)

    // Deleting the profile must clear the project override, not strand a dead id.
    await orcaPage.evaluate(
      async (profileId) => window.__store!.getState().deleteBrowserSessionProfile(profileId),
      profileId
    )
    await expect
      .poll(
        async () => {
          const current = await getStoreState<Repo[]>(orcaPage, 'repos')
          return current.find((entry) => entry.id === repo.id)?.defaultBrowserSessionProfileId
        },
        { timeout: 10_000, message: 'deleted profile stayed on the project record' }
      )
      .toBeUndefined()
  })
})
