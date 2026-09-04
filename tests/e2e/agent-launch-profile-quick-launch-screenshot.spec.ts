import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { configureGoldenStubAgent, getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Captures the before/after screenshots for the launch-profile quick-launch submenu. Not a
// conformance test: it only runs when ORCA_LAUNCH_PROFILE_SHOTS names an output directory.

const outputDir = process.env.ORCA_LAUNCH_PROFILE_SHOTS
// Why: the "before" capture runs against the base branch, which has no launch-profile settings.
const baselineOnly = process.env.ORCA_LAUNCH_PROFILE_SHOTS_BASELINE === '1'
// Why: crop to the tab bar and menu so the proof stays legible at PR width.
const menuClip = { x: 290, y: 0, width: 800, height: 450 }

// Why: the e2e PATH is isolated; the golden stub fixture puts a detectable `codex` on it.
test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test.skip(!outputDir, 'set ORCA_LAUNCH_PROFILE_SHOTS=<dir> to capture screenshots')

test('quick-launch submenu before and after launch profiles @headful', async ({ orcaPage }) => {
  mkdirSync(outputDir!, { recursive: true })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
  // Why: detection ran before the stub override existed and is cached per context; re-detect, and
  // seed the store when the isolated PATH still yields nothing (this is a screenshot, not a probe).
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    await store.getState().updateSettings({ uiLanguage: 'en' })
    await store.getState().refreshDetectedAgents(store.getState().activeWorktreeId ?? undefined)
    if ((store.getState().detectedAgentIds ?? []).length === 0) {
      const byContext = Object.fromEntries(
        Object.keys(store.getState().localDetectedAgentIdsByContext).map((key) => [
          key,
          ['codex', 'claude']
        ])
      )
      store.setState({
        detectedAgentIds: ['codex', 'claude'],
        localDetectedAgentIdsByContext: byContext
      })
    }
  })
  // Why: the e2e profile can surface the recoverable-UI-error dialog on startup (reproduces on
  // untouched main); while it is open the rest of the page is inert to role queries.
  // Why: the e2e profile can surface the recoverable-UI-error dialog at any point (reproduces on
  // untouched main); while it is open the rest of the page is inert to role queries.
  const dismissRecoverableError = async (): Promise<void> => {
    const dismiss = orcaPage.getByRole('button', { name: /^(don't send|不发送)$/i }).first()
    if (await dismiss.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await dismiss.click()
    }
  }
  await dismissRecoverableError()
  // Why: the aria-label is localized; the e2e profile follows the OS locale.
  const newTab = orcaPage.getByRole('button', { name: /^(New tab|新标签页)$/ }).first()
  const codexItem = (): ReturnType<typeof orcaPage.getByRole> =>
    orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()

  if (!baselineOnly) {
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ agentLaunchProfiles: [] })
    })
  }
  await dismissRecoverableError()
  await newTab.click({ force: true })
  await expect(codexItem()).toBeVisible({ timeout: 30_000 })
  await codexItem().hover()
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-before.png'),
    animations: 'disabled',
    clip: menuClip
  })
  if (baselineOnly) {
    return
  }
  // Why: the first Escape only closes the hovered submenu; the root menu needs its own.
  for (let attempt = 0; attempt < 3 && (await codexItem().isVisible()); attempt += 1) {
    await orcaPage.keyboard.press('Escape')
  }
  await expect(codexItem()).toBeHidden({ timeout: 10_000 })

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({
      agentLaunchProfiles: [
        {
          id: 'codex-work-proxy',
          agent: 'codex',
          label: 'Codex · work proxy',
          args: '-c model_provider="work"'
        }
      ]
    })
  })
  await dismissRecoverableError()
  await newTab.click({ force: true })
  await expect(codexItem()).toBeVisible({ timeout: 30_000 })
  await codexItem().hover()
  await expect(orcaPage.getByRole('menuitem', { name: 'Codex · secondary home' })).toBeVisible({
    timeout: 10_000
  })
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'quick-launch-after.png'),
    animations: 'disabled',
    clip: menuClip
  })

  // Composer: the Launch profile select under the agent picker, shown because Codex has profiles.
  for (let attempt = 0; attempt < 3 && (await codexItem().isVisible()); attempt += 1) {
    await orcaPage.keyboard.press('Escape')
  }
  const agentSection = orcaPage.locator('[data-contextual-tour-target="workspace-creation-agent"]')
  // Why: the error dialog can land between the menu closing and this click; retry the open.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissRecoverableError()
    await orcaPage
      .getByRole('button', { name: /^(New workspace|新建工作区)$/ })
      .first()
      .click({ force: true })
    if (await agentSection.isVisible({ timeout: 5_000 }).catch(() => false)) {
      break
    }
  }
  await expect(agentSection).toBeVisible({ timeout: 15_000 })
  // Why: opening the composer re-detects for its own context, which is empty in the isolated
  // profile and would leave only Blank Terminal; seed the store again once that settles.
  await orcaPage.waitForTimeout(1_500)
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const byContext = Object.fromEntries(
      Object.keys(store.getState().localDetectedAgentIdsByContext).map((key) => [
        key,
        ['codex', 'claude']
      ])
    )
    store.setState({
      detectedAgentIds: ['codex', 'claude'],
      isDetectingAgents: false,
      localDetectedAgentIdsByContext: byContext
    })
  })
  await agentSection.locator('[role="combobox"]').first().click()
  await orcaPage
    .getByRole('option', { name: /^Codex(?:\s|$)/i })
    .first()
    .click()
  const profileSelect = agentSection.getByRole('combobox', { name: /^(Launch profile|启动配置)$/ })
  await expect(profileSelect).toBeVisible({ timeout: 15_000 })
  await profileSelect.click()
  await expect(orcaPage.getByRole('option', { name: 'Codex · secondary home' })).toBeVisible({
    timeout: 10_000
  })
  const dialogBox = await orcaPage
    .locator('[role="dialog"]')
    .filter({ hasText: /Create worktree|创建工作树/ })
    .first()
    .boundingBox()
    .catch(() => null)
  await orcaPage.screenshot({
    path: path.join(outputDir!, 'composer-launch-profile.png'),
    animations: 'disabled',
    ...(dialogBox
      ? {
          clip: {
            x: Math.max(0, dialogBox.x - 8),
            y: Math.max(0, dialogBox.y - 8),
            width: dialogBox.width + 16,
            height: dialogBox.height + 16
          }
        }
      : {})
  })
})
