import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { peerNativeWindow } from './helpers/native-desktop-window'
import { waitForSessionReady } from './helpers/store'

async function readSkills(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const [discovery, plan] = await Promise.all([
      window.api.skills.discover(),
      window.api.skills.bundledPlan()
    ])
    return {
      skills: Array.isArray(discovery.skills),
      scope: plan.scope,
      digest: plan.planDigest
    }
  })
  expect(result.skills).toBe(true)
  expect(result.scope).toBe('global')
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
}

test('both native peers discover and plan skills through reload and first-window close', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  const peer = await peerNativeWindow(electronApp, orcaPage)
  await readSkills(orcaPage)
  await readSkills(peer)
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await readSkills(orcaPage)
  await readSkills(peer)
  const firstWindow = await electronApp.browserWindow(orcaPage)
  await firstWindow.evaluate((window) => window.close())
  await expect.poll(() => orcaPage.isClosed()).toBe(true)
  await readSkills(peer)
  await peer.reload()
  await waitForSessionReady(peer)
  await readSkills(peer)
  await expect(peer.locator('[data-worktree-sidebar]')).toBeVisible()
  const screenshot = testInfo.outputPath('native-peer-skills.png')
  await peer.screenshot({ path: screenshot })
  await testInfo.attach('native-peer-skills', { path: screenshot, contentType: 'image/png' })
})
