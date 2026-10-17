/**
 * Settings → Git & Source Control end-to-end.
 *
 * Proves the Git pane renders its real controls, that changing a source-control
 * setting updates the DOM control and persists, that a boolean toggle round-trips,
 * that reopening the pane rehydrates the changed value, and that an invalid custom
 * branch prefix is validated in the DOM.
 *
 * Grounded in:
 *   src/renderer/src/components/settings/settings-git-task-section-renderers.tsx
 *   src/renderer/src/components/settings/GitPane.tsx
 *   src/renderer/src/components/settings/CommitMessageAiPane.tsx
 *   src/renderer/src/components/settings/SettingsFormControls.tsx (role=radio/radiogroup)
 *   src/renderer/src/shared/default-global-settings.ts (defaults)
 */

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeSettingsPage, dismissTransientAnnouncement } from './helpers/ssh-config-host-picker'
import { waitForSessionReady } from './helpers/store'

type GitSettingKey =
  | 'sourceControlGroupOrder'
  | 'refreshLocalBaseRefOnWorktreeCreate'
  | 'sourceControlCompareAgainstUpstream'
  | 'branchPrefixCustom'

/** Secondary persistence check: read the value the Git pane wrote into store settings. */
async function readStoreSetting(page: Page, key: GitSettingKey): Promise<unknown> {
  return page.evaluate((settingKey) => {
    const settings = window.__store?.getState().settings
    if (!settings) {
      return undefined
    }
    return {
      sourceControlGroupOrder: settings.sourceControlGroupOrder,
      refreshLocalBaseRefOnWorktreeCreate: settings.refreshLocalBaseRefOnWorktreeCreate,
      sourceControlCompareAgainstUpstream: settings.sourceControlCompareAgainstUpstream,
      branchPrefixCustom: settings.branchPrefixCustom
    }[settingKey]
  }, key)
}

async function openGitSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    // Why: the spec asserts on English strings; the host may run a non-English locale.
    await store.getState().updateSettings({ uiLanguage: 'en' })
    store.getState().openSettingsTarget({ pane: 'git', repoId: null })
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder('Search settings')).toBeVisible({ timeout: 10_000 })
  await dismissTransientAnnouncement(page)
  await expect(page.locator('[data-settings-section="git"]')).toBeVisible({ timeout: 10_000 })
}

test.describe('Settings Git pane', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('renders the Git pane sections and controls', async ({ orcaPage }) => {
    await openGitSettings(orcaPage)
    const gitSection = orcaPage.locator('[data-settings-section="git"]')

    const groupOrder = gitSection.getByRole('radiogroup', { name: 'Source Control Group Order' })
    await expect(groupOrder).toBeVisible()
    await expect(groupOrder.getByRole('radio', { name: 'Changes first' })).toBeVisible()
    await expect(groupOrder.getByRole('radio', { name: 'Staged first' })).toBeVisible()
    await expect(groupOrder.getByRole('radio', { name: 'Untracked first' })).toBeVisible()

    const compareBase = gitSection.getByRole('radiogroup', { name: 'Default Compare Base' })
    await expect(compareBase).toBeVisible()
    await expect(compareBase.getByRole('radio', { name: 'Repository default' })).toBeVisible()
    await expect(compareBase.getByRole('radio', { name: 'Branch upstream' })).toBeVisible()

    await expect(
      gitSection.getByRole('switch', { name: 'Keep Local Main Up to Date' })
    ).toBeVisible()
    await expect(gitSection.getByRole('switch', { name: 'Auto-Rename Branch' })).toBeVisible()

    await expect(gitSection.getByText('Branch Prefix', { exact: true })).toBeVisible()
    await expect(gitSection.getByRole('button', { name: 'Git Username' })).toBeVisible()
    await expect(gitSection.getByRole('button', { name: 'Custom' })).toBeVisible()
    await expect(gitSection.getByRole('button', { name: 'None' })).toBeVisible()

    const aiSection = gitSection.locator('[data-settings-section="source-control-ai-settings"]')
    await expect(
      aiSection.getByRole('heading', { name: 'Source Control AI defaults' })
    ).toBeVisible()
    await expect(
      aiSection.getByRole('switch', { name: 'Show Source Control AI actions' })
    ).toHaveAttribute('aria-checked', 'true')
  })

  test('changing Source Control Group Order updates the control and persists', async ({
    orcaPage
  }) => {
    await openGitSettings(orcaPage)
    const gitSection = orcaPage.locator('[data-settings-section="git"]')
    const groupOrder = gitSection.getByRole('radiogroup', { name: 'Source Control Group Order' })
    const changesFirst = groupOrder.getByRole('radio', { name: 'Changes first' })
    const stagedFirst = groupOrder.getByRole('radio', { name: 'Staged first' })

    await expect(changesFirst).toHaveAttribute('aria-checked', 'true')
    await expect(stagedFirst).toHaveAttribute('aria-checked', 'false')

    await stagedFirst.click()

    await expect(stagedFirst).toHaveAttribute('aria-checked', 'true')
    await expect(changesFirst).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(() => readStoreSetting(orcaPage, 'sourceControlGroupOrder'), { timeout: 5_000 })
      .toBe('staged-first')
  })

  test('Keep Local Main Up to Date toggles and persists both ways', async ({ orcaPage }) => {
    await openGitSettings(orcaPage)
    const toggle = orcaPage
      .locator('[data-settings-section="git"]')
      .getByRole('switch', { name: 'Keep Local Main Up to Date' })

    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => readStoreSetting(orcaPage, 'refreshLocalBaseRefOnWorktreeCreate'), {
        timeout: 5_000
      })
      .toBe(true)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect
      .poll(() => readStoreSetting(orcaPage, 'refreshLocalBaseRefOnWorktreeCreate'), {
        timeout: 5_000
      })
      .toBe(false)
  })

  test('reopening the Git pane shows the changed value', async ({ orcaPage }) => {
    await openGitSettings(orcaPage)
    const compareBase = orcaPage
      .locator('[data-settings-section="git"]')
      .getByRole('radiogroup', { name: 'Default Compare Base' })

    await expect(compareBase.getByRole('radio', { name: 'Repository default' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await compareBase.getByRole('radio', { name: 'Branch upstream' }).click()
    await expect(compareBase.getByRole('radio', { name: 'Branch upstream' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect
      .poll(() => readStoreSetting(orcaPage, 'sourceControlCompareAgainstUpstream'), {
        timeout: 5_000
      })
      .toBe(true)

    await closeSettingsPage(orcaPage)
    await expect(orcaPage.getByPlaceholder('Search settings')).toBeHidden()

    await openGitSettings(orcaPage)
    const reopened = orcaPage
      .locator('[data-settings-section="git"]')
      .getByRole('radiogroup', { name: 'Default Compare Base' })
    await expect(reopened.getByRole('radio', { name: 'Branch upstream' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await expect(reopened.getByRole('radio', { name: 'Repository default' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  test('invalid custom branch prefix is flagged in the DOM', async ({ orcaPage }) => {
    await openGitSettings(orcaPage)
    const gitSection = orcaPage.locator('[data-settings-section="git"]')

    await gitSection.getByRole('button', { name: 'Custom' }).click()
    const prefixInput = gitSection.getByPlaceholder('e.g. feature')
    await expect(prefixInput).toBeVisible()

    await prefixInput.fill('bad prefix')
    await expect(
      gitSection.getByText(/Prefix cannot contain spaces or special characters/)
    ).toBeVisible()

    await prefixInput.fill('team')
    await expect(
      gitSection.getByText(/Prefix cannot contain spaces or special characters/)
    ).toBeHidden()
    await expect(gitSection.getByText(/Branches will be named team\/feature/)).toBeVisible()
    await expect
      .poll(() => readStoreSetting(orcaPage, 'branchPrefixCustom'), { timeout: 5_000 })
      .toBe('team')
  })
})
