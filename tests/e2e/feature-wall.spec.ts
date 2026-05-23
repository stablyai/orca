import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import type { ElectronApplication } from '@stablyai/playwright-test'

async function openFeatureTourFromMenu(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow, Menu }) => {
    const featureTourItem = Menu.getApplicationMenu()
      ?.items.find((item) => item.label === 'Help')
      ?.submenu?.items.find((item) => item.label === 'Explore Orca')

    if (!featureTourItem) {
      throw new Error('Explore Orca menu item was not registered')
    }

    const window = BrowserWindow.getAllWindows()[0]
    featureTourItem.click(featureTourItem, window, {
      triggeredByAccelerator: false,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false
    } as Electron.KeyboardEvent)
  })
}

test.describe('Feature tour modal', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('opens from the Help menu and renders the workflow rail', async ({
    electronApp,
    orcaPage
  }) => {
    await openFeatureTourFromMenu(electronApp)

    await expect(orcaPage.getByRole('dialog', { name: 'Get to know Orca' })).toBeVisible({
      timeout: 10_000
    })
    await expect(orcaPage.getByText('Reopen any time from Help > Explore Orca.')).toBeVisible()

    // Five workflow rows in the rail.
    const rail = orcaPage.getByRole('navigation', { name: 'Workflows' })
    await expect(rail.getByRole('tab')).toHaveCount(5)
    await expect(rail.getByRole('tab', { name: /Workspaces/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await expect(orcaPage.locator('[data-ws-id]')).toHaveCount(3)

    // ArrowDown moves selection through the rail.
    await rail.getByRole('tab', { name: /Workspaces/i }).focus()
    await orcaPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Tasks/i })).toHaveAttribute('aria-selected', 'true')
    await orcaPage.keyboard.press('ArrowDown')
    await expect(rail.getByRole('tab', { name: /Agents/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    await rail.getByRole('tab', { name: /Workbench/i }).click()
    await rail.getByRole('button', { name: /Browser/i }).click()
    await expect(
      orcaPage.getByText(
        'With the Browser Use skill, agents can navigate, click, inspect, and gather UI evidence inside Orca.'
      )
    ).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'Browser Use skill' })).toBeVisible()
    await expect(
      orcaPage.getByText(
        "Agents can navigate, click, inspect, and gather evidence in Orca's browser."
      )
    ).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: 'CLI skill' })).toHaveCount(0)
    await expect(orcaPage.getByText('With the Orca CLI skill', { exact: false })).toHaveCount(0)
  })

  test('shows disconnected task users setup-oriented copy without leaving the walkthrough', async ({
    orcaPage
  }) => {
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: false },
          glab: { installed: false, authenticated: false },
          bitbucket: { configured: false, authenticated: false, account: null },
          azureDevOps: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          },
          gitea: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    await expect(orcaPage.getByRole('dialog', { name: 'Get to know Orca' })).toBeVisible({
      timeout: 10_000
    })
    await orcaPage
      .getByRole('navigation', { name: 'Workflows' })
      .getByRole('tab', { name: /Tasks/i })
      .click()
    await expect(orcaPage.getByText('Connect GitHub or Linear once')).toBeVisible()
    await expect(orcaPage.getByRole('dialog', { name: 'Get to know Orca' })).toBeVisible()
    await expect
      .poll(async () => getStoreState<string>(orcaPage, 'activeView'))
      .not.toBe('settings')
  })

  test('does not pre-check configured workflows until the user visits them', async ({
    orcaPage
  }) => {
    await orcaPage.evaluate(() => {
      for (const key of [
        'orca.featureWall.visitedWorkflows.v1',
        'orca.featureWall.visitedAgentSteps.v1',
        'orca.featureWall.visitedWorkbenchSteps.v1',
        'orca.featureWall.visitedReviewSteps.v1'
      ]) {
        localStorage.removeItem(key)
      }
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        preflightStatus: {
          git: { installed: true },
          gh: { installed: true, authenticated: true },
          glab: { installed: false, authenticated: false },
          bitbucket: { configured: false, authenticated: false, account: null },
          azureDevOps: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          },
          gitea: {
            configured: false,
            authenticated: false,
            account: null,
            baseUrl: null,
            tokenConfigured: false
          }
        },
        preflightStatusChecked: true,
        preflightStatusLoading: false,
        linearStatus: { connected: false, viewer: null },
        linearStatusChecked: true
      })
      store.getState().openModal('feature-wall', { source: 'help_menu' })
    })

    const rail = orcaPage.getByRole('navigation', { name: 'Workflows' })
    await expect(
      rail.locator('[data-feature-wall-workflow-id] [aria-label="Completed"]')
    ).toHaveCount(0)

    const workspacesTab = rail.locator('[data-feature-wall-workflow-id="workspaces"]')
    const tasksTab = rail.locator('[data-feature-wall-workflow-id="tasks"]')
    await tasksTab.click()
    await expect(tasksTab.locator('[aria-label="Completed"]')).toHaveCount(1)
    await expect(workspacesTab.locator('[aria-label="Completed"]')).toHaveCount(0)
  })

  test('shows the bottom-right nudge and opens the full tour', async ({ orcaPage }) => {
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.getState().closeModal()
      store.getState().showFeatureTourNudge()
    })

    const nudge = orcaPage.getByRole('complementary', {
      name: 'Explore Orca'
    })
    await expect(nudge).toBeVisible()
    await expect(nudge.getByText('See what Orca can do')).toBeVisible()
    await expect(
      nudge.getByText('A quick walkthrough of the workflows built into Orca.')
    ).toBeVisible()
    await expect(nudge.getByText('Reopen any time from Help > Explore Orca.')).toBeVisible()
    await expect(nudge.locator('[data-feature-tour-nudge-visual]')).toHaveCount(0)
    await expect(nudge.getByRole('button', { name: 'Dismiss Explore Orca' })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(nudge).toBeVisible()
    await expect
      .poll(
        () =>
          nudge
            .locator('[data-feature-tour-nudge-caption]')
            .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
        {
          message: 'feature tour nudge caption should not be clipped'
        }
      )
      .toBe(true)
    await expect(nudge.locator('img')).toHaveCount(0)
    await expect(nudge.locator('svg')).toHaveCount(0)

    const takeTourButton = nudge.getByRole('button', { name: /^Take the tour$/ })
    await expect(takeTourButton).toBeVisible()
    await takeTourButton.click()
    await expect(orcaPage.getByRole('dialog', { name: 'Get to know Orca' })).toBeVisible()
    await expect
      .poll(async () => getStoreState<boolean>(orcaPage, 'featureTourNudgeVisible'))
      .toBe(false)
  })
})
