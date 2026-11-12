// Fresh isolated profiles start with closedAt:null so first-launch onboarding paints without seeded completion.

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { chooseOnboardingAgentSurface } from './helpers/onboarding-navigation'
import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import type { TuiAgent } from '../../src/shared/agent-launch/catalog/tui-agent'
import { ONBOARDING_FINAL_STEP } from '../../src/shared/onboarding-defaults'

type OnboardingState = {
  closedAt: number | null
  outcome: 'completed' | 'dismissed' | null
  lastCompletedStep: number
  checklist: Record<string, boolean>
}

const SET_UP_LATER_BUTTON = /^Set up later$/i
const TASK_SOURCES_HEADING = /Set up GitHub tasks/i
const WINDOWS_TERMINAL_HEADING = /Set Windows terminal defaults/i
const ADD_PROJECT_DIALOG_HEADING = /Add (?:a server project|a project|another project)/i

async function getOnboardingState(page: Page): Promise<OnboardingState> {
  return page.evaluate(() => window.api.onboarding.get() as Promise<OnboardingState>)
}

async function getSettings(page: Page): Promise<GlobalSettings> {
  return page.evaluate(() => window.api.settings.get())
}

async function getDocumentThemeClass(page: Page): Promise<'dark' | 'light'> {
  return page.evaluate(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  )
}

function onboardingFooter(page: Page) {
  return page
    .locator('footer')
    .filter({
      has: page.getByRole('button', { name: /Back|Continue|Add your first project|Set up|Skip/i })
    })
    .first()
}

function onboardingFooterButton(page: Page, name: RegExp) {
  return onboardingFooter(page).getByRole('button', { name })
}

function onboardingNotificationSoundSelect(page: Page) {
  return page.getByRole('combobox').first()
}

async function expectOnboardingNotificationSoundMenuClosed(page: Page): Promise<void> {
  await expect(page.getByRole('option', { name: /Choose Custom File/i })).toHaveCount(0)
}

async function expectOnboardingSkipConfirmationClosed(page: Page): Promise<void> {
  await expect(page.getByRole('dialog', { name: /Skip onboarding\?/i })).toHaveCount(0)
}

async function expectOnboardingSkipConfirmationOpen(page: Page): Promise<void> {
  await expect(page.getByRole('dialog', { name: /Skip onboarding\?/i })).toBeVisible()
}

async function expectOnboardingNotificationSound(page: Page, name: RegExp): Promise<void> {
  await expect(onboardingNotificationSoundSelect(page)).toContainText(name)
}

async function chooseOnboardingNotificationSound(page: Page, name: RegExp): Promise<void> {
  const soundSelect = onboardingNotificationSoundSelect(page)
  await soundSelect.click()
  const option = page.getByRole('option', { name })
  await expect(option).toBeVisible()
  // Use keyboard selection because the sound menu overlaps Skip on small viewports.
  await option.press('Enter')
  await expect(soundSelect).toContainText(name)
  await expectOnboardingNotificationSoundMenuClosed(page)
  await expectOnboardingSkipConfirmationClosed(page)
}

async function expectOnboardingCustomSoundOption(page: Page): Promise<void> {
  const soundSelect = onboardingNotificationSoundSelect(page)
  await soundSelect.click()
  await expect(page.getByRole('option', { name: /Choose Custom File/i })).toBeVisible()
  await page.getByRole('option', { selected: true }).press('Enter')
  await expectOnboardingNotificationSoundMenuClosed(page)
  await expectOnboardingSkipConfirmationClosed(page)
}

async function continueOnboarding(page: Page): Promise<void> {
  await onboardingFooterButton(page, /^(Continue|Add your first project)\b/).click()
}

async function expectOnboardingProgress(page: Page, label: RegExp): Promise<void> {
  await expect(page.getByText(label)).toBeVisible()
}

async function expectMainPage(page: Page): Promise<void> {
  await expect(page.locator('[data-onboarding-overlay]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING })).toHaveCount(0)
}

async function completeOnboardingIntoWorkspace(page: Page): Promise<void> {
  await continueThroughOptionalTaskSourcesAndWindowsTerminal(page)
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
  await expectOnboardingProgress(page, /^[456] of [456]$/)
  await expect(onboardingFooterButton(page, /^Continue\b/)).toBeVisible()
  await continueOnboarding(page)
  await expect(page.locator('[data-onboarding-overlay]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING })).toHaveCount(0)
}

async function continueThroughOptionalTaskSourcesAndWindowsTerminal(page: Page): Promise<void> {
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await expectOnboardingProgress(page, /^4 of [56]$/)
    await continueOnboarding(page)
  }
  const windowsTerminalVisible = await page
    .getByRole('heading', { name: WINDOWS_TERMINAL_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (windowsTerminalVisible) {
    await expectOnboardingProgress(page, /^[45] of [56]$/)
    await continueOnboarding(page)
  }
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
}

async function continueFromThemeToNotifications(page: Page): Promise<void> {
  await continueOnboarding(page)
  await continueThroughOptionalTaskSourcesAndWindowsTerminal(page)
}

test.describe('Onboarding flow', () => {
  // Opt out of the fixture’s completed-onboarding seed to exercise first launch.
  test.use({ dismissOnboarding: false })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
  })

  test('Chat surface saves with the agent page and survives going back', async ({ orcaPage }) => {
    await chooseOnboardingAgentSurface(orcaPage, 'chat')
    expect((await getSettings(orcaPage)).agentDefaultSurface).not.toBe('chat')
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expect.poll(async () => (await getSettings(orcaPage)).agentDefaultSurface).toBe('chat')
    await orcaPage.getByRole('button', { name: 'Back', exact: true }).click()
    await orcaPage.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(orcaPage.getByRole('radio', { name: /^Chat UI/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })

  test('Continue advances steps, persists progress, and applies user-visible settings', async ({
    orcaPage
  }) => {
    await expect(
      orcaPage.getByRole('heading', { name: /How do you want to work with agents/i })
    ).toBeVisible()
    await expectOnboardingProgress(orcaPage, /^1 of [456]$/)
    await expect(orcaPage.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    await chooseOnboardingAgentSurface(orcaPage)

    await expectOnboardingProgress(orcaPage, /^2 of [456]$/)
    await expect(onboardingFooterButton(orcaPage, /^Continue\b/)).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SET_UP_LATER_BUTTON)).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Back', exact: true })).toHaveCount(1)
    // Scope the platform-specific Cmd/Ctrl hint to Continue so background shortcut hints cannot satisfy it.
    await expect(
      onboardingFooterButton(orcaPage, /^Continue\b/)
        .locator('span')
        .filter({ hasText: /⌘|Ctrl/ })
        .first()
    ).toBeVisible()

    // Choose nondefault Codex to prove the wizard writes the choice; expand the catalog if needed.
    const targetAgent: TuiAgent = 'codex'
    const codexButton = orcaPage.getByRole('button', { name: /^Codex\b/ })
    // Wait for mount before choosing the Show more branch; isVisible is only a one-shot probe.
    const codexVisible = await codexButton
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!codexVisible) {
      await orcaPage.getByText(/Show \d+ more agents/).click()
    }
    await codexButton.click()
    await expect(codexButton).toHaveAttribute('aria-pressed', 'true')

    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expectOnboardingProgress(orcaPage, /^3 of [456]$/)
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance to 1 after first Continue'
      })
      .toBe(1)
    await expect
      .poll(async () => (await getSettings(orcaPage)).defaultTuiAgent, { timeout: 5_000 })
      .toBe(targetAgent)

    // Wait for async system-theme resolution, then choose the opposite tile to prove immediate application.
    await orcaPage.waitForFunction(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.classList.contains('light')
    )
    const startingTheme = await getDocumentThemeClass(orcaPage)
    const oppositeTheme: 'dark' | 'light' = startingTheme === 'dark' ? 'light' : 'dark'
    const oppositeTileName = oppositeTheme === 'light' ? /Bright & crisp/ : /Easy on the eyes/
    await orcaPage.getByRole('radio', { name: oppositeTileName }).click()
    await expect
      .poll(async () => getDocumentThemeClass(orcaPage), { timeout: 5_000 })
      .toBe(oppositeTheme)

    await continueOnboarding(orcaPage)
    // Require theme step 2 committed; skipped integration/platform steps can advance lastCompletedStep further.
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance past the theme step after second Continue'
      })
      .toBeGreaterThanOrEqual(2)
    await expect
      .poll(async () => (await getSettings(orcaPage)).theme, { timeout: 5_000 })
      .toBe(oppositeTheme)
    await continueThroughOptionalTaskSourcesAndWindowsTerminal(orcaPage)
    await expectOnboardingProgress(orcaPage, /^[456] of [456]$/)
    await expect
      .poll(async () => [3, 4].includes((await getOnboardingState(orcaPage)).lastCompletedStep), {
        timeout: 5_000,
        message: 'lastCompletedStep did not include optional setup progress'
      })
      .toBe(true)

    await expectOnboardingNotificationSound(orcaPage, /System Default/i)
    await expect(orcaPage.getByRole('button', { name: /Send Test Notification/i })).toBeVisible()
    await expectOnboardingCustomSoundOption(orcaPage)

    await completeOnboardingIntoWorkspace(orcaPage)

    await expect
      .poll(
        async () => {
          const s = await getSettings(orcaPage)
          return {
            agentTaskComplete: s.notifications.agentTaskComplete,
            terminalBell: s.notifications.terminalBell,
            enabled: s.notifications.enabled,
            customSoundId: s.notifications.customSoundId
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({
        agentTaskComplete: true,
        terminalBell: true,
        enabled: true,
        customSoundId: 'system'
      })

    await expect
      .poll(
        async () => {
          const state = await getOnboardingState(orcaPage)
          return {
            closedAt: state.closedAt === null ? null : 'set',
            outcome: state.outcome,
            addedRepo: state.checklist.addedRepo,
            lastCompletedStep: state.lastCompletedStep
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({
        closedAt: 'set',
        outcome: 'completed',
        addedRepo: false,
        lastCompletedStep: ONBOARDING_FINAL_STEP
      })
  })

  test('Cmd/Ctrl+Enter advances steps like Continue', async ({ orcaPage }) => {
    await chooseOnboardingAgentSurface(orcaPage)

    // Use renderer UA like OnboardingFlow’s Cmd/Ctrl decision.
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const accelerator = isMac ? 'Meta+Enter' : 'Control+Enter'

    // Anchor focus inside the overlay so hidden-window synthetic keys reach its capture listener.
    await orcaPage.locator('footer').click({ position: { x: 1, y: 1 } })
    await orcaPage.keyboard.press(accelerator)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('Set up later completes first-use and Help replay into the main page, preserving the selected agent', async ({
    orcaPage
  }) => {
    await chooseOnboardingAgentSurface(orcaPage)
    const codexButton = orcaPage.getByRole('button', { name: /^Codex\b/ })
    const codexVisible = await codexButton
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!codexVisible) {
      await orcaPage.getByText(/Show \d+ more agents/).click()
    }
    await codexButton.click()

    await onboardingFooterButton(orcaPage, SET_UP_LATER_BUTTON).click()

    await expectMainPage(orcaPage)

    await expect
      .poll(
        async () => {
          const state = await getOnboardingState(orcaPage)
          return {
            closedAt: state.closedAt === null ? null : 'set',
            outcome: state.outcome,
            dismissed: state.checklist.dismissed,
            lastCompletedStep: state.lastCompletedStep
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({
        closedAt: 'set',
        outcome: 'completed',
        dismissed: false,
        lastCompletedStep: ONBOARDING_FINAL_STEP
      })
    await expect
      .poll(async () => (await getSettings(orcaPage)).defaultTuiAgent, { timeout: 5_000 })
      .toBe('codex')

    await orcaPage.getByRole('button', { name: 'Help', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'Onboarding', exact: true }).click()
    await onboardingFooterButton(orcaPage, SET_UP_LATER_BUTTON).click()
    await expectMainPage(orcaPage)
  })

  test('notification sound choice persists on Continue', async ({ orcaPage }) => {
    await chooseOnboardingAgentSurface(orcaPage)
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await chooseOnboardingNotificationSound(orcaPage, /^Ding$/i)

    await completeOnboardingIntoWorkspace(orcaPage)
    await expect
      .poll(
        async () => {
          const s = await getSettings(orcaPage)
          return {
            agentTaskComplete: s.notifications.agentTaskComplete,
            terminalBell: s.notifications.terminalBell,
            customSoundId: s.notifications.customSoundId
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({ agentTaskComplete: true, terminalBell: true, customSoundId: 'ding' })
  })

  test('Back returns to the previous step without losing progress', async ({ orcaPage }) => {
    await chooseOnboardingAgentSurface(orcaPage)

    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)

    // Why: exact match — the app sidebar also exposes a "Go back" button that
    // would otherwise match this regex.
    await orcaPage.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible()
    await expectOnboardingProgress(orcaPage, /^2 of [456]$/)

    // Back changes only the visible step; poll async IPC persistence to require lastCompletedStep stays 1.
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('final notification step can be dismissed via Escape or click-off', async ({ orcaPage }) => {
    await chooseOnboardingAgentSurface(orcaPage)

    // On the final step, Continue closes into the workspace; Escape/click-off must still offer skip confirmation.
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SET_UP_LATER_BUTTON)).toHaveCount(0)

    await orcaPage.keyboard.press('Escape')
    await expectOnboardingSkipConfirmationOpen(orcaPage)
    await orcaPage.getByRole('button', { name: /No, keep going/i }).click()
    await expectOnboardingSkipConfirmationClosed(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    expect((await getOnboardingState(orcaPage)).closedAt).toBeNull()

    await orcaPage.locator('[data-onboarding-overlay]').click({ position: { x: 8, y: 40 } })
    await expectOnboardingSkipConfirmationOpen(orcaPage)
    await orcaPage.getByRole('button', { name: /^Skip$/ }).click()

    await expect
      .poll(
        async () => {
          const state = await getOnboardingState(orcaPage)
          return {
            closedAt: state.closedAt === null ? null : 'set',
            outcome: state.outcome,
            dismissed: state.checklist.dismissed
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({ closedAt: 'set', outcome: 'dismissed', dismissed: true })
  })
})
