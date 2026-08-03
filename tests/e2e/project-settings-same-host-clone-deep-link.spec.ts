/**
 * Regression test for #11689: editing the third project's properties opened the
 * first project's pane.
 *
 * Two clones of one remote collapse into a single project by design, so both
 * live on the same host. The `{pane:'repo', repoId}` deep link only carried the
 * host, and the pane then fell back to that host's *first* setup — so "Project
 * Settings" on the second clone rendered the first clone's properties.
 */
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const SHARED_REMOTE = {
  canonicalKey: 'github.com/acme/app',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:acme/app.git'
}

// The collapsed project's single pane is keyed by its representative repo row.
const COLLAPSED_PANE = '[data-settings-section="repo-clone-1"]'

async function openProjectSettings(page: Page, repoId: string): Promise<void> {
  await page.evaluate((targetRepoId) => {
    const state = window.__store!.getState()
    state.setSettingsSearchQuery('')
    state.openSettingsTarget({ pane: 'repo', repoId: targetRepoId })
    state.openSettingsPage()
  }, repoId)
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  // Why: first-run announcements can cover the settings pane on fresh profiles.
  const maybeLaterButton = page.getByRole('button', { name: 'Maybe Later' })
  if (await maybeLaterButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await maybeLaterButton.click()
  }
}

test.describe('Project Settings deep link with same-host clones', () => {
  test('opens the clone that was asked for, not the host first setup', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)

    await orcaPage.evaluate(async (sharedRemote) => {
      const store = window.__store!
      // Why: the spec asserts on English strings; the host may run another locale.
      await store.getState().updateSettings({ uiLanguage: 'en' })
      store.setState({
        repos: [
          {
            id: 'clone-1',
            path: '/repos/one',
            displayName: 'One',
            badgeColor: '#111111',
            addedAt: 1,
            gitRemoteIdentity: sharedRemote
          },
          {
            id: 'solo-2',
            path: '/repos/two',
            displayName: 'Two',
            badgeColor: '#222222',
            addedAt: 2
          },
          {
            id: 'clone-3',
            path: '/repos/three',
            displayName: 'Three',
            badgeColor: '#333333',
            addedAt: 3,
            gitRemoteIdentity: sharedRemote
          }
        ],
        projects: [],
        projectHostSetups: []
      })
    }, SHARED_REMOTE)

    await openProjectSettings(orcaPage, 'clone-3')
    await expect(orcaPage.locator(COLLAPSED_PANE)).toContainText('/repos/three')
    await expect(orcaPage.locator(COLLAPSED_PANE)).not.toContainText('/repos/one')

    // The first clone still resolves to itself, so this is a real selection and
    // not a blanket switch to the last setup.
    await openProjectSettings(orcaPage, 'clone-1')
    await expect(orcaPage.locator(COLLAPSED_PANE)).toContainText('/repos/one')
    await expect(orcaPage.locator(COLLAPSED_PANE)).not.toContainText('/repos/three')
  })
})
