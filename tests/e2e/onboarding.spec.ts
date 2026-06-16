/* eslint-disable max-lines -- Why: onboarding E2E coverage shares one first-launch wizard fixture and step helpers; splitting this file would make the linear flow harder to audit. */
/**
 * E2E tests for the first-launch Onboarding flow.
 *
 * The onboarding overlay is gated by `OnboardingState.closedAt === null` (see
 * `shouldShowOnboarding` in `should-show-onboarding.ts`). Each test gets a fresh
 * Electron instance + isolated userData dir, so persistence starts clean and
 * the overlay renders on first paint without any setup.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings, TuiAgent } from '../../src/shared/types'

type OnboardingState = {
  closedAt: number | null
  outcome: 'completed' | 'dismissed' | null
  lastCompletedStep: number
  checklist: Record<string, boolean>
}

const SKIP_TO_PROJECT_SETUP_BUTTON = /^Skip to project setup$/i
const TASK_SOURCES_HEADING = /Set up GitHub tasks/i
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

async function expectOnboardingNotificationSound(page: Page, name: RegExp): Promise<void> {
  await expect(onboardingNotificationSoundSelect(page)).toContainText(name)
}

async function chooseOnboardingNotificationSound(page: Page, name: RegExp): Promise<void> {
  const soundSelect = onboardingNotificationSoundSelect(page)
  await soundSelect.click()
  const option = page.getByRole('option', { name })
  await expect(option).toBeVisible()
  // Why: the select menu extends over the onboarding footer on small CI
  // viewports; keyboard selection avoids pointer fall-through to Skip.
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

async function expectAddProjectDialog(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING })).toBeVisible()
}

async function continueFromPostNotificationsToRepo(page: Page): Promise<void> {
  if (await page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING }).isVisible()) {
    return
  }
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await expectOnboardingProgress(page, /^3 of 4$/)
    await continueOnboarding(page)
  }
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
  await expectOnboardingProgress(page, /^[34] of [34]$/)
  await expect(onboardingFooterButton(page, /^Add your first project\b/)).toBeVisible()
  await continueOnboarding(page)
  await expectAddProjectDialog(page)
}

async function continueThroughOptionalTaskSourcesToNotifications(page: Page): Promise<void> {
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await expectOnboardingProgress(page, /^3 of 4$/)
    await continueOnboarding(page)
  }
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
}

async function continueFromThemeToNotifications(page: Page): Promise<void> {
  await continueOnboarding(page)
  await continueThroughOptionalTaskSourcesToNotifications(page)
}

test.describe('Onboarding flow', () => {
  // Why: the shared fixture pre-seeds onboarding as closed so non-onboarding
  // tests don't get blocked by the fullscreen overlay. Opt out here so this
  // spec actually exercises the first-launch flow.
  test.use({ dismissOnboarding: false })

  test.beforeEach(async ({ orcaPage }) => {
    // Per-test userData is freshly minted by the orcaPage fixture, so persisted
    // onboarding state defaults to `closedAt: null, lastCompletedStep: -1` and
    // the overlay paints on its own once App's bootstrap effect resolves.
    await waitForSessionReady(orcaPage)
  })

  test('renders on first launch with the agent step active', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await expectOnboardingProgress(orcaPage, /^1 of [34]$/)
    await expect(onboardingFooterButton(orcaPage, /^Continue\b/)).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toBeVisible()
    // Why: Back is not rendered on the first step (was previously rendered-but-
    // disabled with `disabled:invisible`, now conditionally mounted).
    await expect(orcaPage.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    // Footer hint shows the platform-correct continue shortcut (⌘ on Mac,
    // Ctrl elsewhere). Match either form so the test runs cross-platform.
    // Why: scope to the footer action so background UI shortcut hints cannot
    // false-positive this assertion.
    await expect(
      onboardingFooterButton(orcaPage, /^Continue\b/)
        .locator('span')
        .filter({ hasText: /⌘|Ctrl/ })
        .first()
    ).toBeVisible()
  })

  test('Continue advances steps, persists progress, and applies user-visible settings', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    // --- Step 1: agent ---
    // Force a deterministic, non-default selection so the assertion below
    // proves the wizard actually wrote the user's choice (not just the
    // pre-selected detected agent). Codex sits in the top-6 catalog when no
    // agents are detected, otherwise behind the "Show N more agents" details
    // expander — open it if codex isn't visible.
    const targetAgent: TuiAgent = 'codex'
    const codexButton = orcaPage.getByRole('button', { name: /^Codex\s/ })
    // Why: isVisible() is a one-shot probe — on slow renderer paint it would
    // race the wizard mount and falsely take the "show more agents" branch.
    // waitFor with a small timeout actually retries until the button paints.
    const codexVisible = await codexButton
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!codexVisible) {
      await orcaPage.getByText(/Show \d+ more agents/).click()
    }
    await codexButton.click()

    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expectOnboardingProgress(orcaPage, /^2 of [34]$/)
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance to 1 after first Continue'
      })
      .toBe(1)
    // The agent choice must be persisted to settings (the user will see this
    // pre-selected when they later open a new tab / agent picker).
    await expect
      .poll(async () => (await getSettings(orcaPage)).defaultTuiAgent, { timeout: 5_000 })
      .toBe(targetAgent)

    // --- Step 2: theme ---
    // Default settings.theme is 'system', so the document class can resolve to
    // either 'dark' or 'light' depending on the host. Click the opposite tile
    // so we always observe a live flip — the assertion that proves the wizard
    // applies the choice immediately, not just on Continue.
    // Why: 'system' resolves async on mount, so wait for the class to settle
    // before snapshotting — otherwise startingTheme can be stale.
    await orcaPage.waitForFunction(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.classList.contains('light')
    )
    const startingTheme = await getDocumentThemeClass(orcaPage)
    const oppositeTheme: 'dark' | 'light' = startingTheme === 'dark' ? 'light' : 'dark'
    const oppositeTileName = oppositeTheme === 'light' ? /Bright & crisp/ : /Easy on the eyes/
    await orcaPage.getByRole('button', { name: oppositeTileName }).click()
    await expect
      .poll(async () => getDocumentThemeClass(orcaPage), { timeout: 5_000 })
      .toBe(oppositeTheme)

    await continueOnboarding(orcaPage)
    await expect
      .poll(async () => [2, 3].includes((await getOnboardingState(orcaPage)).lastCompletedStep), {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance after second Continue'
      })
      .toBe(true)
    await expect
      .poll(async () => (await getSettings(orcaPage)).theme, { timeout: 5_000 })
      .toBe(oppositeTheme)
    await continueThroughOptionalTaskSourcesToNotifications(orcaPage)
    await expectOnboardingProgress(orcaPage, /^[34] of [34]$/)
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not include optional task-source progress'
      })
      .toBe(3)

    // --- Step 3: notifications ---
    await expectOnboardingNotificationSound(orcaPage, /System Default/i)
    await expect(orcaPage.getByRole('button', { name: /Send Test Notification/i })).toBeVisible()
    await expectOnboardingCustomSoundOption(orcaPage)

    await continueFromPostNotificationsToRepo(orcaPage)

    // Verify the source defaults land without asking users to configure each
    // source in the onboarding UI.
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
        lastCompletedStep: 4
      })
  })

  test('Cmd/Ctrl+Enter advances steps like Continue', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    // Why: the OS the renderer reports drives whether Cmd or Ctrl is the
    // accelerator (OnboardingFlow.tsx checks navigator.userAgent).
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const accelerator = isMac ? 'Meta+Enter' : 'Control+Enter'

    // Why: in headless Linux CI the window-level capture-phase listener can
    // miss synthetic keyboard events when no element holds focus. Click an
    // inert area inside the overlay first to anchor focus, then press.
    await orcaPage.locator('footer').click({ position: { x: 1, y: 1 } })
    await orcaPage.keyboard.press(accelerator)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('Skip opens Add Project, saves the selected agent, and completes onboarding', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    const codexButton = orcaPage.getByRole('button', { name: /^Codex\s/ })
    const codexVisible = await codexButton
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!codexVisible) {
      await orcaPage.getByText(/Show \d+ more agents/).click()
    }
    await codexButton.click()

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()

    await expectAddProjectDialog(orcaPage)

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
        lastCompletedStep: 4
      })
    await expect
      .poll(async () => (await getSettings(orcaPage)).defaultTuiAgent, { timeout: 5_000 })
      .toBe('codex')
  })

  test('Skip from theme restores the entry theme choice', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()

    await orcaPage.waitForFunction(
      () =>
        document.documentElement.classList.contains('dark') ||
        document.documentElement.classList.contains('light')
    )
    const entryTheme = (await getSettings(orcaPage)).theme
    const startingTheme = await getDocumentThemeClass(orcaPage)
    const oppositeTheme: 'dark' | 'light' = startingTheme === 'dark' ? 'light' : 'dark'
    const oppositeTileName = oppositeTheme === 'light' ? /Bright & crisp/ : /Easy on the eyes/
    await orcaPage.getByRole('button', { name: oppositeTileName }).click()
    await expect
      .poll(async () => getDocumentThemeClass(orcaPage), { timeout: 5_000 })
      .toBe(oppositeTheme)

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()

    await expectAddProjectDialog(orcaPage)
    await expect
      .poll(async () => (await getSettings(orcaPage)).theme, { timeout: 5_000 })
      .toBe(entryTheme)
    await expect
      .poll(async () => getDocumentThemeClass(orcaPage), { timeout: 5_000 })
      .toBe(startingTheme)
  })

  test('Skip preserves runtime server project setup UI', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({ activeRuntimeEnvironmentId: 'env-e2e' })
    })
    await expect
      .poll(async () => (await getSettings(orcaPage)).activeRuntimeEnvironmentId, {
        timeout: 5_000
      })
      .toBe('env-e2e')

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()

    await expectAddProjectDialog(orcaPage)
    await expect(orcaPage.getByRole('button', { name: /Browse server/i })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Clone from URL/i })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Create on server/i })).toBeVisible()
    await expect(orcaPage.getByText(/Or enter a server path manually/i)).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    expect((await getOnboardingState(orcaPage)).closedAt).not.toBeNull()
  })

  test('Skip from notifications does not request permission', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await orcaPage.evaluate(() => {
      localStorage.removeItem('orca.e2e.notificationPermissionRequested')
      window.api.notifications.requestPermission = async () => {
        localStorage.setItem('orca.e2e.notificationPermissionRequested', '1')
        return { supported: true, platform: 'darwin', requested: true }
      }
    })
    await expectOnboardingNotificationSound(orcaPage, /System Default/i)

    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    await continueOnboarding(orcaPage)

    await expectAddProjectDialog(orcaPage)
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => localStorage.getItem('orca.e2e.notificationPermissionRequested')),
        { timeout: 5_000 }
      )
      .toBeNull()
  })

  test('selected agent button reports aria-pressed=true', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    const codexButton = orcaPage.getByRole('button', { name: /^Codex\s/ })
    const codexVisible = await codexButton
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
    if (!codexVisible) {
      await orcaPage.getByText(/Show \d+ more agents/).click()
    }
    await codexButton.click()
    // Why: AgentButton now sets aria-pressed so screen readers and assistive
    // tech can announce the selection. Verify the attribute reflects state.
    await expect(codexButton).toHaveAttribute('aria-pressed', 'true')
  })

  test('notification sound choice persists on Continue', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await chooseOnboardingNotificationSound(orcaPage, /^Ding$/i)

    await continueFromPostNotificationsToRepo(orcaPage)
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

  test('typing in the clone-url input does not hijack Enter as a global shortcut', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    // Advance to the Add Project dialog.
    await continueOnboarding(orcaPage)
    await continueOnboarding(orcaPage)
    await continueFromPostNotificationsToRepo(orcaPage)
    await orcaPage.getByRole('button', { name: /Clone from URL/i }).click()

    // Why: focus the clone-url input and press Cmd/Ctrl+Enter. The capture-
    // phase keydown handler should bail via isEditableTarget, so the dialog
    // should remain visible and the empty clone form must not submit.
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const accelerator = isMac ? 'Meta+Enter' : 'Control+Enter'
    const input = orcaPage.getByPlaceholder('https://github.com/user/repo.git')
    await input.click()
    await input.press(accelerator)
    // Brief wait so any (incorrect) handler firing would have already happened.
    await orcaPage.waitForTimeout(250)
    await expect(orcaPage.getByRole('heading', { name: /Clone from URL/i })).toBeVisible()
    await expect(input).toBeVisible()
    expect((await getOnboardingState(orcaPage)).closedAt).not.toBeNull()
  })

  test('Back returns to the previous step without losing progress', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

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
    await expectOnboardingProgress(orcaPage, /^1 of [34]$/)

    // Why: "without losing progress" means persisted lastCompletedStep stays
    // at 1 — Back rewinds the visible step but must not roll persistence back.
    // Poll because persistence flushes async via IPC after the Back click.
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('final notification step does not offer a skip or dismiss action', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    // Advance through the optional preference step. The final notification step
    // finishes onboarding, so no skip/dismiss path should be available there.
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    await expect(onboardingFooterButton(orcaPage, /Skip all onboarding/i)).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expectOnboardingSkipConfirmationClosed(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await orcaPage.locator('[data-onboarding-overlay]').click({ position: { x: 8, y: 40 } })
    await expectOnboardingSkipConfirmationClosed(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()

    await continueOnboarding(orcaPage)
    await expectAddProjectDialog(orcaPage)
    const final = await getOnboardingState(orcaPage)
    expect(final.closedAt).not.toBeNull()
    expect(final.outcome).toBe('completed')
    expect(final.checklist.dismissed).toBe(false)
    expect(final.lastCompletedStep).toBe(4)
  })
})
