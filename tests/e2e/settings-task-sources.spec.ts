/**
 * E2E tests for Settings → Tasks (task sources) and how the Tasks sidebar and
 * Tasks page source picker react.
 *
 * The Tasks settings pane exposes each provider as a card with a "Show/Hide …
 * Tasks" toggle (TasksPane.tsx + TaskSourceProviderCard.tsx). The default task
 * source is chosen from the Tasks page source bar (SourceBar.tsx); clicking a
 * source there persists `settings.defaultTaskSource`. The sidebar renders one
 * shortcut per available + visible provider (SidebarTaskNavButton.tsx).
 *
 * Assertions target the rendered DOM; store reads only confirm setup.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'
import { dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'

type TaskProvider = 'github' | 'gitlab' | 'linear' | 'jira'

const PROVIDER_LABELS: Record<TaskProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira'
}

const TASK_PROVIDERS: TaskProvider[] = ['github', 'gitlab', 'linear', 'jira']

function tasksSettingsSection(page: Page) {
  return page.locator('[data-settings-section="tasks"]')
}

function sourceFilters(page: Page) {
  return page.locator('[data-contextual-tour-target="tasks-source-filters"]')
}

function sourceButton(page: Page, provider: TaskProvider) {
  return page.locator(`[data-task-source="${provider}"]`)
}

function providerVisibilityToggle(page: Page, provider: TaskProvider) {
  const label = PROVIDER_LABELS[provider]
  return page.getByRole('button', {
    name: new RegExp(`^(Hide|Show) ${label} (from|in) Tasks$`)
  })
}

function sidebarProviderShortcut(page: Page, provider: TaskProvider) {
  return page.getByRole('button', {
    name: `Open ${PROVIDER_LABELS[provider]} tasks`
  })
}

async function openTasksSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'tasks', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({
    timeout: 10_000
  })
  await dismissTransientAnnouncement(page)
  await expect(tasksSettingsSection(page)).toBeVisible({ timeout: 10_000 })
}

/** Leave Settings so the shell (and its worktree sidebar) renders again. */
async function returnToShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().closeSettingsPage()
  })
}

async function openTasksPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    store.getState().openTaskPage()
  })
  await expect(sourceFilters(page)).toBeVisible({ timeout: 10_000 })
}

/** Force the two always-available code-host gating inputs to a disconnected state. */
async function forceUnavailableProviders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    store.setState({
      // Why: freeze the connection checks so a host with glab/Linear configured
      // cannot re-fetch and re-add the providers mid-assertion.
      refreshPreflightStatus: async () => {},
      checkLinearConnection: async () => {},
      linearStatus: { ...state.linearStatus, connected: false },
      preflightStatus: state.preflightStatus
        ? {
            ...state.preflightStatus,
            glab: { installed: false, authenticated: false }
          }
        : state.preflightStatus
    })
  })
}

test.describe('Settings task sources', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('lists provider options with visibility toggles and a default-source picker', async ({
    orcaPage
  }) => {
    await openTasksSettings(orcaPage)

    const section = tasksSettingsSection(orcaPage)
    for (const provider of TASK_PROVIDERS) {
      await expect(section.getByText(PROVIDER_LABELS[provider], { exact: true })).toBeVisible()
      await expect(providerVisibilityToggle(orcaPage, provider)).toBeVisible()
    }

    // The default-source picker lives on the Tasks page source bar.
    await openTasksPage(orcaPage)
    await expect(sourceFilters(orcaPage).locator('button[data-task-source]').first()).toBeVisible()
    await expect(sourceFilters(orcaPage).locator('button[aria-pressed="true"]')).toHaveCount(1)
    await expect(sourceButton(orcaPage, 'github')).toHaveAttribute('aria-pressed', 'true')
  })

  test('hiding a provider drops it from settings and the Tasks source filters, showing restores it', async ({
    orcaPage
  }) => {
    await openTasksPage(orcaPage)
    await expect(sourceButton(orcaPage, 'jira')).toHaveCount(1)

    await openTasksSettings(orcaPage)
    await providerVisibilityToggle(orcaPage, 'jira').click()
    // The same control flips to "Show Jira in Tasks" once hidden.
    await expect(orcaPage.getByRole('button', { name: 'Show Jira in Tasks' })).toBeVisible()
    const hiddenProviders = await getStoreState<string[]>(orcaPage, 'settings.visibleTaskProviders')
    expect(hiddenProviders).not.toContain('jira')

    await openTasksPage(orcaPage)
    await expect(sourceButton(orcaPage, 'jira')).toHaveCount(0)
    await expect(sourceButton(orcaPage, 'github')).toHaveCount(1)

    await openTasksSettings(orcaPage)
    await providerVisibilityToggle(orcaPage, 'jira').click()
    await expect(orcaPage.getByRole('button', { name: 'Hide Jira from Tasks' })).toBeVisible()

    await openTasksPage(orcaPage)
    await expect(sourceButton(orcaPage, 'jira')).toHaveCount(1)
  })

  test('picking a source on the Tasks page persists the default and reopening lands on it', async ({
    orcaPage
  }) => {
    await openTasksPage(orcaPage)
    await expect(sourceButton(orcaPage, 'github')).toHaveAttribute('aria-pressed', 'true')

    await sourceButton(orcaPage, 'jira').click()
    await expect(sourceButton(orcaPage, 'jira')).toHaveAttribute('aria-pressed', 'true')
    await expect(sourceButton(orcaPage, 'github')).toHaveAttribute('aria-pressed', 'false')
    await expect
      .poll(() => getStoreState<string>(orcaPage, 'settings.defaultTaskSource'))
      .toBe('jira')

    // Reopen with no explicit source: it must resolve to the persisted default.
    await orcaPage.evaluate(() => window.__store?.getState().closeTaskPage())
    await openTasksPage(orcaPage)
    await expect(sourceButton(orcaPage, 'jira')).toHaveAttribute('aria-pressed', 'true')
    await expect(sourceButton(orcaPage, 'github')).toHaveAttribute('aria-pressed', 'false')
  })

  test('sidebar shortcuts follow the visible providers', async ({ orcaPage }) => {
    // The worktree sidebar is hidden while Settings is a full-page view, so each
    // assertion about its shortcuts runs after returning to the shell.
    await openTasksSettings(orcaPage)
    await returnToShell(orcaPage)
    // GitHub and Jira are always available, so both shortcuts render on a fresh profile.
    await expect(sidebarProviderShortcut(orcaPage, 'github')).toHaveCount(1)
    await expect(sidebarProviderShortcut(orcaPage, 'jira')).toHaveCount(1)

    await openTasksSettings(orcaPage)
    await providerVisibilityToggle(orcaPage, 'jira').click()
    await expect(orcaPage.getByRole('button', { name: 'Show Jira in Tasks' })).toBeVisible()
    await returnToShell(orcaPage)
    await expect(sidebarProviderShortcut(orcaPage, 'jira')).toHaveCount(0)
    await expect(sidebarProviderShortcut(orcaPage, 'github')).toHaveCount(1)

    await openTasksSettings(orcaPage)
    await providerVisibilityToggle(orcaPage, 'jira').click()
    await returnToShell(orcaPage)
    await expect(sidebarProviderShortcut(orcaPage, 'jira')).toHaveCount(1)
  })

  test('gates providers without an integration out of the Tasks source selector', async ({
    orcaPage
  }) => {
    // Wait until the host checks settle so forcing state does not race a refetch.
    await expect
      .poll(() => getStoreState<boolean>(orcaPage, 'preflightStatusChecked'), {
        timeout: 20_000
      })
      .toBe(true)
    await expect
      .poll(() => getStoreState<boolean>(orcaPage, 'linearStatusChecked'), {
        timeout: 20_000
      })
      .toBe(true)

    await forceUnavailableProviders(orcaPage)
    await openTasksPage(orcaPage)

    // The settings still list all four providers...
    const visibleProviders = await getStoreState<string[]>(
      orcaPage,
      'settings.visibleTaskProviders'
    )
    expect(visibleProviders).toEqual(expect.arrayContaining(['gitlab', 'linear']))
    // ...but the source picker only offers the ones that can actually load.
    await expect(sourceButton(orcaPage, 'github')).toHaveCount(1)
    await expect(sourceButton(orcaPage, 'jira')).toHaveCount(1)
    await expect(sourceButton(orcaPage, 'gitlab')).toHaveCount(0)
    await expect(sourceButton(orcaPage, 'linear')).toHaveCount(0)
  })
})
