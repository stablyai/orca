/**
 * Onboarding journey: persistence/resume across an app restart, plus the
 * per-provider integrations connect surface.
 *
 * The onboarding overlay is gated by `OnboardingState.closedAt === null` (see
 * `shouldShowOnboarding`). The two restart scenarios therefore seed an *open*
 * `orca-data.json` (`closedAt: null`) into the restart profile before the first
 * launch, advance the wizard, quit, and relaunch against the same userDataDir to
 * prove the resume state is durable. The default `orcaPage` fixture only seeds a
 * *completed* onboarding profile, so these tests own their launches through
 * `createRestartSession` and opt out of the shared fixture with
 * `test.use({ dismissOnboarding: false })`.
 *
 * The integrations scenario drives the Settings -> Integrations pane, which is
 * where the real per-provider connect rows live (the onboarding task-setup step
 * intentionally shows only GitHub plus a pointer to Settings). GitHub/GitLab are
 * CLI-status rows; Linear and Jira expose connect dialogs.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { ONBOARDING_FLOW_VERSION } from '../../src/shared/onboarding-defaults'

const AGENT_STEP_HEADING = /Pick your default agent/i
const THEME_STEP_HEADING = /Make it feel like home/i
const ADD_PROJECT_DIALOG_HEADING = /Add (?:a server project|a project|another project)/i

type OnboardingState = {
  closedAt: number | null
  outcome: 'completed' | 'dismissed' | null
  lastCompletedStep: number
}

async function getOnboardingState(page: Page): Promise<OnboardingState> {
  return page.evaluate(() => window.api.onboarding.get())
}

/**
 * Seed an open (first-run) onboarding document into the shared restart profile.
 * A partial `onboarding` object is fine: the loader merges checklist defaults,
 * and the completed-profile `ui` fields keep first-run education modals out of
 * the way so only the onboarding overlay is on screen.
 */
function seedOpenOnboarding(userDataDir: string, lastCompletedStep: number): void {
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(
      {
        ...profile,
        onboarding: {
          flowVersion: ONBOARDING_FLOW_VERSION,
          closedAt: null,
          outcome: null,
          lastCompletedStep
        }
      },
      null,
      2
    )}\n`
  )
}

/** The onboarding footer is the one that offers "Skip to project setup". */
function onboardingFooter(page: Page) {
  return page
    .locator('footer')
    .filter({ has: page.getByRole('button', { name: /Skip to project setup/i }) })
    .first()
}

async function openIntegrationsSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English copy; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'integrations', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
}

test.describe('Onboarding resume across restart', () => {
  // Why: these restart tests seed their own open onboarding profile; opting out
  // of the default dismissal documents that the overlay is meant to be present.
  test.use({ dismissOnboarding: false })

  test('relaunch resumes at the last completed step instead of step 0', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const session = createRestartSession(testInfo)
    seedOpenOnboarding(session.userDataDir, -1)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      await expect(first.page.getByRole('heading', { name: AGENT_STEP_HEADING })).toBeVisible({
        timeout: 30_000
      })

      // Why: the primary button's accessible name carries the submit-shortcut
      // hint (e.g. "Continue ⌘"), so anchor with a word boundary, not `$`.
      await onboardingFooter(first.page)
        .getByRole('button', { name: /^Continue\b/ })
        .click()
      await expect(first.page.getByRole('heading', { name: THEME_STEP_HEADING })).toBeVisible({
        timeout: 15_000
      })
      await expect
        .poll(async () => (await getOnboardingState(first.page)).lastCompletedStep, {
          timeout: 5_000,
          message: 'lastCompletedStep did not advance to 1 after Continue'
        })
        .toBe(1)

      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)

      // Resume, not restart: the overlay reopens on the theme step.
      await expect(second.page.getByRole('dialog', { name: 'Orca onboarding' })).toBeVisible({
        timeout: 30_000
      })
      await expect(second.page.getByRole('heading', { name: THEME_STEP_HEADING })).toBeVisible({
        timeout: 15_000
      })
      await expect(second.page.getByRole('heading', { name: AGENT_STEP_HEADING })).toHaveCount(0)
    } finally {
      if (secondApp) {
        await session.close(secondApp).catch(() => undefined)
      }
      if (firstApp) {
        await session.close(firstApp).catch(() => undefined)
      }
      await session.dispose()
    }
  })

  test('relaunch does not re-show the overlay once onboarding is completed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    test.setTimeout(300_000)
    const session = createRestartSession(testInfo)
    seedOpenOnboarding(session.userDataDir, -1)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await session.launch()
      firstApp = first.app
      await waitForSessionReady(first.page)
      await expect(first.page.getByRole('heading', { name: AGENT_STEP_HEADING })).toBeVisible({
        timeout: 30_000
      })

      // "Skip to project setup" is a completion path: it stamps closedAt +
      // outcome=completed and hands off to Add Project.
      await onboardingFooter(first.page)
        .getByRole('button', { name: /^Skip to project setup$/i })
        .click()
      await expect(
        first.page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING })
      ).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(
          async () => {
            const state = await getOnboardingState(first.page)
            return { closed: state.closedAt !== null, outcome: state.outcome }
          },
          { timeout: 5_000, message: 'onboarding did not persist a completed outcome' }
        )
        .toEqual({ closed: true, outcome: 'completed' })

      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      await waitForSessionReady(second.page)

      await expect(second.page.locator('[data-onboarding-overlay]')).toHaveCount(0)
      await expect(second.page.getByRole('dialog', { name: 'Orca onboarding' })).toHaveCount(0)
      await expect(second.page.getByRole('heading', { name: AGENT_STEP_HEADING })).toHaveCount(0)
      // The main shell is what the user lands on instead.
      await expect(second.page.locator('#root')).toBeVisible()
    } finally {
      if (secondApp) {
        await session.close(secondApp).catch(() => undefined)
      }
      if (firstApp) {
        await session.close(firstApp).catch(() => undefined)
      }
      await session.dispose()
    }
  })
})

test.describe('Integrations step per provider', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await openIntegrationsSettings(orcaPage)
  })

  test('lists every provider row and opens the Linear and Jira connect dialogs', async ({
    orcaPage
  }) => {
    // GitHub and GitLab are CLI-status rows (install / auth-command guidance).
    await expect(
      orcaPage.getByText('Pull requests, issues, and checks via the').first()
    ).toBeVisible({ timeout: 15_000 })
    await expect(
      orcaPage.getByText('Merge requests, issues, todos, and pipelines via the').first()
    ).toBeVisible()

    // Linear and Jira are the connect-dialog rows.
    const linearCard = orcaPage.locator('[data-settings-section="integrations-linear"]')
    const jiraCard = orcaPage.locator('[data-settings-section="integrations-jira"]')
    await expect(linearCard).toBeVisible({ timeout: 15_000 })
    await expect(jiraCard).toBeVisible()

    const linearOpen = linearCard.getByRole('button', {
      name: /^(Add Linear access|Add workspace access)$/
    })
    await expect(linearOpen).toBeVisible({ timeout: 15_000 })
    await linearOpen.click()
    const linearDialog = orcaPage.getByRole('dialog', { name: 'Add Linear access' })
    await expect(linearDialog).toBeVisible()
    await linearDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(linearDialog).toBeHidden()

    const jiraOpen = jiraCard.getByRole('button', { name: /^(Connect Jira|Add Jira site)$/ })
    await expect(jiraOpen).toBeVisible({ timeout: 15_000 })
    await jiraOpen.click()
    const jiraDialog = orcaPage.getByRole('dialog', { name: 'Connect Jira site' })
    await expect(jiraDialog).toBeVisible()
    await jiraDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(jiraDialog).toBeHidden()
  })
})
