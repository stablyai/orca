import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

const HIDDEN_DESCRIPTION =
  'The onboarding checklist is hidden. You can show it again whenever you need it.'

async function openSetupGuideSettings(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'setup-guide', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible()
  await dismissTransientAnnouncement(page)
}

async function expectChecklistVisible(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Hide checklist', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { name: 'Setup', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Milestones', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show checklist', exact: true })).toHaveCount(0)
  await expect(page.getByText(HIDDEN_DESCRIPTION, { exact: true })).toHaveCount(0)
}

async function expectChecklistHidden(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Show checklist', exact: true })).toBeEnabled()
  await expect(page.getByText(HIDDEN_DESCRIPTION, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Hide checklist', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Setup', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Milestones', exact: true })).toHaveCount(0)
}

test('remembers hidden and restored Settings checklist across restarts', async (// oxlint-disable-next-line no-empty-pattern -- this test owns each Electron launch.
{}, testInfo) => {
  test.setTimeout(300_000)
  const session = createRestartSession(testInfo, { ORCA_BACKGROUND_LAUNCH: '1' })
  const profile = getE2ECompletedOnboardingProfile()
  writeFileSync(
    path.join(session.userDataDir, 'orca-data.json'),
    JSON.stringify({
      ...profile,
      ui: {
        ...profile.ui,
        featureInteractions: {},
        setupGuideBrowserMilestoneMigrated: true,
        setupGuideBrowserMilestoneLegacyComplete: false
      }
    })
  )
  let activeApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    activeApp = first.app
    await openSetupGuideSettings(first.page)
    await expectChecklistVisible(first.page)
    await expect(first.page.getByText('0/2', { exact: true })).toBeVisible()
    await testInfo.attach('checklist-shown', {
      body: await first.page.screenshot({ path: testInfo.outputPath('checklist-shown.png') }),
      contentType: 'image/png'
    })
    await first.page.getByRole('button', { name: 'Hide checklist', exact: true }).click()
    await expectChecklistHidden(first.page)
    await testInfo.attach('checklist-hidden', {
      body: await first.page.screenshot({ path: testInfo.outputPath('checklist-hidden.png') }),
      contentType: 'image/png'
    })

    await session.close(activeApp)
    activeApp = null

    const second = await session.launch()
    activeApp = second.app
    await openSetupGuideSettings(second.page)
    await expectChecklistHidden(second.page)
    await second.page.getByRole('button', { name: 'Show checklist', exact: true }).click()
    await expectChecklistVisible(second.page)

    await session.close(activeApp)
    activeApp = null

    const third = await session.launch()
    activeApp = third.app
    await openSetupGuideSettings(third.page)
    await expectChecklistVisible(third.page)
    await expect(third.page.getByText('0/2', { exact: true })).toBeVisible()
    await testInfo.attach('checklist-restored-after-restart', {
      body: await third.page.screenshot({
        path: testInfo.outputPath('checklist-restored-after-restart.png')
      }),
      contentType: 'image/png'
    })
  } finally {
    try {
      if (activeApp) {
        await session.close(activeApp)
      }
    } finally {
      await session.dispose()
    }
  }
})
