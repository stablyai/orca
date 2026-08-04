/**
 * Coverage for the full native emoji picker that replaced the hardcoded
 * 12-emoji grid in the repo icon settings (RepositoryIconTabs "Emoji" tab).
 * Verifies search + selection persist through the existing RepoIcon
 * contract, and captures the new picker for the PR screenshot record.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { Repo } from '../../src/shared/types'

/** Opens the repo settings panel and pins the UI language to English. */
async function openRepoSettings(page: Page, repoId: string): Promise<void> {
  // Why: the host OS locale (e.g. ko-KR) drives Orca's default UI language.
  // Pin English so this spec's locators are stable across dev machines and CI.
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

/** Captures a full-page screenshot and attaches it to the test report. */
async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path: screenshotPath })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Repository icon emoji picker', () => {
  test('search selects a native emoji and persists it as the repo icon', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)

    const repos = await getStoreState<Repo[]>(orcaPage, 'repos')
    expect(repos.length).toBeGreaterThan(0)
    const repo = repos[0]

    await openRepoSettings(orcaPage, repo.id)

    const repoSection = orcaPage.locator(`[data-settings-section="repo-${repo.id}"]`)
    await repoSection.getByRole('tab', { name: 'Emoji' }).click()

    const picker = repoSection.locator('.repo-icon-emoji-picker')
    await expect(picker).toBeVisible({ timeout: 10_000 })

    // Full catalog with search — the removed grid only ever offered 12 fixed emoji.
    const searchInput = picker.getByPlaceholder('Search emoji')
    await expect(searchInput).toBeVisible()
    await searchInput.fill('rocket')

    await attachScreenshot(orcaPage, testInfo, 'repo-icon-emoji-picker-search')

    const rocketResult = picker.getByRole('button', { name: /rocket/i }).first()
    await expect(rocketResult).toBeVisible({ timeout: 10_000 })
    await rocketResult.click()

    await expect
      .poll(
        async () => {
          const current = await getStoreState<Repo[]>(orcaPage, 'repos')
          return current.find((entry) => entry.id === repo.id)?.repoIcon
        },
        { timeout: 5_000, message: 'repo icon did not persist the picked emoji' }
      )
      .toEqual({ type: 'emoji', emoji: '🚀' })

    // The store round-trip alone would pass even if the panel rendered nothing.
    await expect(repoSection.getByText('Current: 🚀')).toBeVisible()

    await attachScreenshot(orcaPage, testInfo, 'repo-icon-emoji-picker-selected')
  })
})
