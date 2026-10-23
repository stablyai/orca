/**
 * "Bring Orca to Front" in the running app: a completion reveals its tab only when the turn that
 * just ended carries a person's submission. Stand-in agents post provider-shaped hooks while the
 * test writes to their PTYs as a person (keys through xterm) or as Orca (terminal.send, dictation
 * paste). Windowless launch keeps every reveal off the desktop; the reveal's renderer IPC and the
 * tab it lands on are the observable outcome.
 * Positives reveal the right tab; refusals produce no reveal before the next event.
 * Verdict correctness for refusals is proven in the integration tests.
 *
 * macOS only, like the setting: today's CI e2e jobs run on Linux and Windows, so CI skips this file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { writeFakeReplyAgent } from './helpers/reply-reveal-fake-agent'
import { setUpReplyRevealHarness } from './helpers/reply-reveal-harness'
import { installReplyRevealProbes } from './helpers/reply-reveal-probes'
import { runClaudeReplyScenarios, runCodexReplyScenarios } from './helpers/reply-reveal-scenarios'

test.describe('Bring Orca to Front on a person-submitted reply', () => {
  test.skip(process.platform !== 'darwin', 'The setting exists only on macOS')
  let fakeDir = ''
  let agentScript = ''
  test.beforeEach(() => {
    fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-reply-reveal-'))
    agentScript = writeFakeReplyAgent(fakeDir)
  })
  test.afterEach(() => {
    rmSync(fakeDir, { recursive: true, force: true })
  })

  test('Claude: prompt ids with a person and a human origin reveal their tab', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(360_000)
    await runClaudeReplyScenarios(
      await setUpReplyRevealHarness(orcaPage, electronApp, fakeDir, agentScript)
    )
  })

  test('Codex: turn ids with a person submission reveal their tab', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(300_000)
    await runCodexReplyScenarios(
      await setUpReplyRevealHarness(orcaPage, electronApp, fakeDir, agentScript)
    )
  })

  test('the toggle shows on macOS and follows its parent switches', async ({
    orcaPage,
    electronApp
  }) => {
    await waitForSessionReady(orcaPage)
    // Captures any banner so nothing posts to the desktop.
    await installReplyRevealProbes(electronApp)
    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      // Labels below are English; the host locale may pick another language.
      await state.updateSettings({ uiLanguage: 'en' })
      state.openSettingsTarget({ pane: 'notifications', repoId: null })
      state.openSettingsPage()
    })
    const section = orcaPage.locator('[data-settings-section="notifications"]')
    const notifications = section.getByRole('switch', { name: 'Enable Notifications' })
    const taskComplete = section.getByRole('switch', { name: 'Agent Task Complete' })
    const bringToFront = section.getByRole('switch', { name: 'Bring Orca to Front' })
    await expect(bringToFront).toBeVisible({ timeout: 10_000 })
    await expect(bringToFront).toHaveAttribute('aria-checked', 'false')
    await expect(bringToFront).toBeEnabled()
    await bringToFront.click()
    await expect(bringToFront).toHaveAttribute('aria-checked', 'true')

    await taskComplete.click()
    await expect(bringToFront).toBeDisabled()
    await taskComplete.click()
    await expect(bringToFront).toBeEnabled()
    await notifications.click()
    await expect(bringToFront).toBeDisabled()
    await notifications.click()
    await expect(bringToFront).toBeEnabled()
    await expect(bringToFront).toHaveAttribute('aria-checked', 'true')
  })
})
