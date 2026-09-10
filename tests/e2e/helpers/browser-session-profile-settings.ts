/**
 * Drivers for the session-profile list in Settings → Browser.
 *
 * The `orcaOnBrowserSettings` fixture hands back an Orca that can be quit and
 * relaunched against the same on-disk profile, with every launch already sitting
 * on Settings → Browser — which is what a persistence spec needs, and what
 * the default single-launch `orcaPage` fixture cannot give it.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test as base } from './orca-app'
import { createRestartSession } from './orca-restart'
import { waitForSessionReady } from './store'

const PROFILE_ROW = '[data-testid="browser-session-profile-row"]'
const PROFILE_ID_ATTRIBUTE = 'data-browser-session-profile-id'
const PROFILE_ACTIVE_ATTRIBUTE = 'data-browser-session-profile-active'

type RelaunchableOrcaOnBrowserSettings = {
  /** Launch (or relaunch) Orca against the shared profile, on Settings → Browser. */
  launch: () => Promise<Page>
  /** Quit every launch still running, so the next `launch` reads persisted state. */
  quit: () => Promise<void>
}

export const test = base.extend<{
  orcaOnBrowserSettings: RelaunchableOrcaOnBrowserSettings
}>({
  // Why a fixture: the launches must be closed and the shared profile removed even
  // when an assertion throws, which Playwright guarantees for fixture teardown.
  // A spec asking only for this never resolves `electronApp`, so the shared
  // single-launch app stays unstarted.
  orcaOnBrowserSettings: async (
    // oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
    {},
    provideFixture,
    testInfo
  ) => {
    const session = createRestartSession(testInfo)
    const running: Awaited<ReturnType<typeof session.launch>>['app'][] = []

    const quit = async (): Promise<void> => {
      // Why swallow: a failing close during teardown must not mask the assertion
      // that actually failed, and the other launches still need closing.
      await Promise.all(running.splice(0).map((app) => session.close(app).catch(() => undefined)))
    }

    await provideFixture({
      launch: async () => {
        const { app, page } = await session.launch()
        running.push(app)
        await waitForSessionReady(page)
        await openBrowserSessionProfileSettings(page)
        return page
      },
      quit
    })

    await quit()
    await session.dispose()
  }
})

function profileRow(page: Page, profileId: string) {
  return page.locator(`${PROFILE_ROW}[${PROFILE_ID_ATTRIBUTE}=${JSON.stringify(profileId)}]`)
}

function activeProfileRows(page: Page) {
  return page.locator(`${PROFILE_ROW}[${PROFILE_ACTIVE_ATTRIBUTE}="true"]`)
}

async function openBrowserSessionProfileSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'browser', repoId: null })
    state.openSettingsPage()
    void state.fetchBrowserSessionProfiles()
  })
  await expect(profileRow(page, 'default')).toBeVisible()
}

/** Create a session profile, make it active, and wait for its row to render; returns its id. */
export async function createAndSelectBrowserSessionProfile(
  page: Page,
  label: string
): Promise<string> {
  const profileId = await page.evaluate(async (profileLabel) => {
    const state = window.__store!.getState()
    const profile = await state.createBrowserSessionProfile('isolated', profileLabel, {})
    if (!profile) {
      throw new Error('browser session profile was not created')
    }
    state.setDefaultBrowserSessionProfileId(profile.id)
    return profile.id
  }, label)
  await expect(profileRow(page, profileId)).toContainText(label)
  return profileId
}

/**
 * Assert this profile's row is the one and only row Settings → Browser marks Active.
 *
 * Why one helper rather than an exported row locator: Active is a property of the
 * whole list — exactly one row wins — so a caller holding a single row would have
 * to re-derive that rule, and a stale second Active row would pass unnoticed.
 */
export async function expectOnlyActiveBrowserSessionProfile(
  page: Page,
  profileId: string
): Promise<void> {
  await expect(profileRow(page, profileId)).toHaveAttribute(PROFILE_ACTIVE_ATTRIBUTE, 'true')
  await expect(activeProfileRows(page)).toHaveCount(1)
}
