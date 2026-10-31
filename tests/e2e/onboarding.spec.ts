// Fresh isolated profiles start with closedAt:null so first-launch onboarding paints without seeded completion.

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import type { TuiAgent } from '../../src/shared/tui-agent'
import { ONBOARDING_FINAL_STEP } from '../../src/shared/onboarding-defaults'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../src/shared/pairing'

type OnboardingState = {
  closedAt: number | null
  outcome: 'completed' | 'dismissed' | null
  lastCompletedStep: number
  checklist: Record<string, boolean>
}

const SKIP_TO_PROJECT_SETUP_BUTTON = /^Skip to project setup$/i
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

async function expectAddProjectDialog(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING })).toBeVisible()
}

async function continueFromPostNotificationsToRepo(page: Page): Promise<void> {
  if (await page.getByRole('heading', { name: ADD_PROJECT_DIALOG_HEADING }).isVisible()) {
    return
  }
  await continueThroughOptionalTaskSourcesAndWindowsTerminal(page)
  await expect(page.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
  await expectOnboardingProgress(page, /^[345] of [345]$/)
  await expect(onboardingFooterButton(page, /^Add your first project\b/)).toBeVisible()
  await continueOnboarding(page)
  await expectAddProjectDialog(page)
}

async function continueThroughOptionalTaskSourcesAndWindowsTerminal(page: Page): Promise<void> {
  const taskSourcesVisible = await page
    .getByRole('heading', { name: TASK_SOURCES_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (taskSourcesVisible) {
    await expectOnboardingProgress(page, /^3 of [45]$/)
    await continueOnboarding(page)
  }
  const windowsTerminalVisible = await page
    .getByRole('heading', { name: WINDOWS_TERMINAL_HEADING })
    .waitFor({ state: 'visible', timeout: 1_000 })
    .then(() => true)
    .catch(() => false)
  if (windowsTerminalVisible) {
    await expectOnboardingProgress(page, /^[34] of [45]$/)
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

  test('Continue advances steps, persists progress, and applies user-visible settings', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    await expectOnboardingProgress(orcaPage, /^1 of [345]$/)
    await expect(onboardingFooterButton(orcaPage, /^Continue\b/)).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    // Scope the platform-specific Cmd/Ctrl hint to Continue so background shortcut hints cannot satisfy it.
    await expect(
      onboardingFooterButton(orcaPage, /^Continue\b/)
        .locator('span')
        .filter({ hasText: /⌘|Ctrl/ })
        .first()
    ).toBeVisible()

    // Choose nondefault Codex to prove the wizard writes the choice; expand the catalog if needed.
    const targetAgent: TuiAgent = 'codex'
    const codexButton = orcaPage.getByRole('button', { name: 'Codex', exact: true })
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
    await expectOnboardingProgress(orcaPage, /^2 of [345]$/)
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
    await orcaPage.getByRole('button', { name: oppositeTileName }).click()
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
    await expectOnboardingProgress(orcaPage, /^[345] of [345]$/)
    await expect
      .poll(async () => [3, 4].includes((await getOnboardingState(orcaPage)).lastCompletedStep), {
        timeout: 5_000,
        message: 'lastCompletedStep did not include optional setup progress'
      })
      .toBe(true)

    await expectOnboardingNotificationSound(orcaPage, /System Default/i)
    await expect(orcaPage.getByRole('button', { name: /Send Test Notification/i })).toBeVisible()
    await expectOnboardingCustomSoundOption(orcaPage)

    await continueFromPostNotificationsToRepo(orcaPage)

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
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

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

  test('Skip opens Add Project, saves the selected agent, and completes onboarding', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    const codexButton = orcaPage.getByRole('button', { name: 'Codex', exact: true })
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
        lastCompletedStep: ONBOARDING_FINAL_STEP
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
    // #10011: register a real environment before its dedicated Active Server handler can persist selection; offline pairing suffices.
    const pairingCode = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      scope: 'runtime',
      endpoint: 'wss://e2e.invalid/ws',
      deviceToken: 'e2e-device-token',
      publicKeyB64: 'ZTJlLXB1YmxpYy1rZXk'
    })
    const environmentId = await orcaPage.evaluate(async (code) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const { environment } = await window.api.runtimeEnvironments.addFromPairingCode({
        name: 'E2E Server',
        pairingCode: code
      })
      // #5071: populate registered runtimeEnvironments, which gates server-path add.
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      // Only live compatible status makes a host auto-selectable; protocol 3 clears the minimum version gate.
      const seededStatus = {
        runtimeId: `${environment.id}-runtime`,
        rendererGraphEpoch: 0,
        graphStatus: 'ready' as const,
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 1
      }
      // #20003: pin a top-sequence host snapshot so unreachable-host checking publications cannot change the seeded available health.
      store.getState().setRuntimeEnvironmentStatus(environment.id, {
        snapshot: {
          environmentId: environment.id,
          pairingRevision: environment.pairingRevision ?? environment.createdAt,
          sequence: Number.MAX_SAFE_INTEGER,
          checkedAt: Date.now(),
          status: seededStatus,
          verification: 'verified',
          transport: 'ready'
        },
        status: seededStatus,
        checkedAt: Date.now()
      })
      // Set selection directly and use returned settings; reachability probes/refetch would overwrite the synthetic available host.
      const settings = await window.api.settings.setActiveRuntimeEnvironmentPreference({
        environmentId: environment.id
      })
      store.setState({ settings })
      return environment.id
    }, pairingCode)
    await expect
      .poll(async () => (await getSettings(orcaPage)).activeRuntimeEnvironmentId, {
        timeout: 5_000
      })
      .toBe(environmentId)

    // Health derives from transport/verification snapshots; pin a verified ready snapshot above live publications.
    await orcaPage.evaluate((id) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const environment = state.runtimeEnvironments.find((entry) => entry.id === id)
      if (!environment) {
        throw new Error('runtime environment was not registered')
      }
      state.applyRuntimeHostStatusSnapshot({
        environmentId: id,
        pairingRevision: environment.pairingRevision ?? environment.createdAt,
        sequence: 2_147_483_647,
        checkedAt: Date.now(),
        status: {
          runtimeId: `${id}-runtime`,
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 1
        },
        verification: 'verified',
        transport: 'ready',
        remoteControl: null
      })
    }, environmentId)

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()

    await expectAddProjectDialog(orcaPage)
    // The runtime env is selected as the Add Project host and the browse action
    // is host-scoped, proving the server project-setup UI is preserved on skip.
    await expect(orcaPage.getByText('Existing Git repository or folder on this host')).toBeVisible({
      timeout: 30_000
    })
    await expect(orcaPage.getByRole('button', { name: /Browse folder/i })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Clone from URL/i })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Create new project/i })).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    expect((await getOnboardingState(orcaPage)).closedAt).not.toBeNull()
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
    await continueOnboarding(orcaPage)
    await continueOnboarding(orcaPage)
    await continueFromPostNotificationsToRepo(orcaPage)
    await orcaPage.getByRole('button', { name: /Clone from URL/i }).click()

    // Press Cmd/Ctrl+Enter in the editable clone field; the capture handler must leave the dialog and empty form alone.
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
    await expectOnboardingProgress(orcaPage, /^1 of [345]$/)

    // Back changes only the visible step; poll async IPC persistence to require lastCompletedStep stays 1.
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('final notification step can be dismissed via Escape or click-off', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    // On the final step, primary hands off to Add Project; Escape/click-off must still offer skip confirmation.
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueFromThemeToNotifications(orcaPage)

    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)

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
