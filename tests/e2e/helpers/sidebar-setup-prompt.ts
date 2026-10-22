import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../src/shared/repo-host-identity'

/**
 * Dismisses the setup-script prompt for every loaded repo, as its Dismiss button does. The seeded
 * repo's detected setup command shows the card over the sidebar's lower rows, and it re-inspects
 * and reappears whenever the active workspace changes, so a visibility check can miss it.
 */
export async function dismissSetupScriptPrompts(page: Page): Promise<void> {
  const repos = await page.evaluate(() =>
    (window.__store?.getState().repos ?? []).map((repo) => ({
      id: repo.id,
      connectionId: repo.connectionId ?? null,
      executionHostId: repo.executionHostId ?? null
    }))
  )
  const identities = repos.map((repo) =>
    getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
  )
  await page.evaluate((keys) => {
    const state = window.__store?.getState()
    for (const key of keys) {
      state?.dismissSetupScriptPrompt(key)
    }
  }, identities)
  await expect(page.locator('[data-setup-script-prompt-layer]')).toHaveCount(0)
}
