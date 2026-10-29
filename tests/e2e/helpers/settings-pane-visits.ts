import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { SettingsNavTarget } from '../../../src/renderer/src/lib/settings-navigation-types'

/**
 * Opens Settings and shows each pane in turn, waiting until it has mounted (only the active pane
 * mounts, so its reads run only then), then closes Settings. `repoId` adds that project's pane.
 */
export async function visitSettingsPanes(
  page: Page,
  panes: readonly SettingsNavTarget[],
  repoId: string | null = null
): Promise<void> {
  const targets: { pane: SettingsNavTarget; section: string }[] = [
    ...panes.map((pane) => ({ pane, section: `[data-settings-section="${pane}"]` })),
    ...(repoId
      ? [{ pane: 'repo' as const, section: `[data-settings-section="repo-${repoId}"]` }]
      : [])
  ]
  for (const { pane, section } of targets) {
    await page.evaluate(
      ({ pane, repoId }) => {
        const state = window.__store?.getState()
        state?.openSettingsTarget({ pane, repoId: pane === 'repo' ? repoId : null })
        state?.openSettingsPage()
      },
      { pane, repoId }
    )
    await expect(page.locator(`section${section}`).first()).toBeVisible({ timeout: 30_000 })
  }
  await page.evaluate(() => window.__store?.getState().closeSettingsPage())
}
