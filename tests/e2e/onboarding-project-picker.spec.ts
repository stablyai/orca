// A fresh profile pinned to the landing-page start: no `~` workspace, and onboarding hands off to Add Project.

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { chooseOnboardingAgentSurface } from './helpers/onboarding-navigation'

const ADD_PROJECT_DIALOG = /Add (?:a server project|a project|another project)/i

test.use({
  dismissOnboarding: false,
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_FIRST_LAUNCH_LAYOUT: 'project-picker' }
})

function footerButton(page: Page, name: RegExp) {
  return page.locator('[data-onboarding-modal] footer').getByRole('button', { name })
}

async function repoNames(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__store!.getState().repos.map((repo) => repo.displayName))
}

async function closeAddProject(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG })).toHaveCount(0)
}

test.describe('Onboarding from the landing page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('starts without a workspace and finishes in Add Project', async ({ orcaPage }) => {
    expect(await repoNames(orcaPage)).toEqual([])
    await chooseOnboardingAgentSurface(orcaPage)
    await expect(footerButton(orcaPage, /^Skip to project setup$/)).toBeVisible()

    const heading = orcaPage.locator('[data-onboarding-modal]').getByRole('heading').first()
    for (let step = 0; step < 5; step += 1) {
      if (/Set up notifications/i.test(await heading.innerText())) {
        break
      }
      const title = await heading.innerText()
      await footerButton(orcaPage, /^Continue\b/).click()
      await expect(heading).not.toHaveText(title)
    }
    await footerButton(orcaPage, /^Add your first project\b/).click()

    await expect(orcaPage.locator('[data-onboarding-overlay]')).toHaveCount(0)
    await closeAddProject(orcaPage)
    await expect(orcaPage.getByText('Add a project to get started.')).toBeVisible()
    expect(await repoNames(orcaPage)).toEqual([])
    await expect
      .poll(() => orcaPage.evaluate(() => window.api.settings.get()))
      .toMatchObject({ telemetry: { firstLaunchLayout: 'project-picker' } })
  })

  test('Skip to project setup opens Add Project on first use and Help replay', async ({
    orcaPage
  }) => {
    await chooseOnboardingAgentSurface(orcaPage)
    await footerButton(orcaPage, /^Skip to project setup$/).click()
    await expect(orcaPage.locator('[data-onboarding-overlay]')).toHaveCount(0)
    await closeAddProject(orcaPage)

    await orcaPage.getByRole('button', { name: 'Help', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'Onboarding', exact: true }).click()
    await footerButton(orcaPage, /^Skip to project setup$/).click()
    await closeAddProject(orcaPage)
    expect(await repoNames(orcaPage)).toEqual([])
  })
})
