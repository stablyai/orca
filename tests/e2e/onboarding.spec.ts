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

const ORCHESTRATION_ENABLED_STORAGE_KEY = 'orca.orchestration.enabled'
const BROWSER_USE_ENABLED_STORAGE_KEY = 'orca.browserUse.enabled'
const SKIP_TO_PROJECT_SETUP_BUTTON = /^Skip to project setup$/i
const TASK_SOURCES_HEADING = /Connect your task sources/i
const REPO_STEP_HEADING = /Point Orca at some code/i

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

async function installSafeOnboardingFeatureSetupDeps(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__onboardingFeatureSetupDeps = {
      getCliStatus: async () => ({
        platform: 'darwin',
        commandName: 'orca',
        commandPath: '/usr/local/bin/orca',
        pathDirectory: '/usr/local/bin',
        pathConfigured: true,
        launcherPath: '/Applications/Orca.app/Contents/MacOS/Orca',
        installMethod: 'symlink',
        supported: true,
        state: 'installed',
        currentTarget: '/Applications/Orca.app/Contents/MacOS/Orca',
        unsupportedReason: null,
        detail: null
      }),
      installCli: async () => {
        throw new Error('CLI registration should not run in this onboarding E2E')
      },
      writeClipboardText: async (text) => {
        localStorage.setItem('orca.e2e.onboardingFeatureSetupClipboard', text)
      },
      getComputerUsePermissionStatus: async () => ({
        platform: 'darwin',
        permissions: [
          { id: 'accessibility', status: 'granted' },
          { id: 'screenshots', status: 'granted' }
        ]
      }),
      openComputerUsePermissionSetup: async () => {
        throw new Error('Computer Use setup should not open in this onboarding E2E')
      },
      setStorageItem: (key, value) => localStorage.setItem(key, value),
      removeStorageItem: (key) => localStorage.removeItem(key),
      notifyOrchestrationStateChanged: () => {
        window.dispatchEvent(new CustomEvent('orca:orchestration-setup-state'))
      }
    }
  })
}

async function expectSkillSetupTerminalReady(page: Page): Promise<void> {
  await expect(page.getByRole('region', { name: /Skill setup command/i })).toBeInViewport({
    timeout: 10_000
  })
  await expect(
    page.getByText(/Press Enter to run the command and confirm npx if asked/i)
  ).toBeVisible()
  await expect
    .poll(
      async () =>
        page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')),
      {
        timeout: 10_000,
        message: 'Skill setup command terminal did not receive keyboard focus'
      }
    )
    .toBe(true)
}

function onboardingFooter(page: Page) {
  return page
    .locator('footer')
    .filter({
      has: page.getByRole('button', { name: /Back|Continue|Set up|Skip/i })
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
  await onboardingFooterButton(page, /^Continue\b/).click()
}

async function setupOnboardingFeatures(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Enable capabilities$/i }).click()
}

async function continueFromFeatureSetupToRepo(page: Page): Promise<void> {
  await continueOnboarding(page)
  await expect(page.getByRole('heading', { name: TASK_SOURCES_HEADING })).toBeVisible()
  await expect(page.getByText('5 of 7')).toBeVisible()
  await continueOnboarding(page)
  await expect(page.getByText('6 of 7')).toBeVisible()
  await expect(page.getByRole('heading', { name: /^Explore Orca$/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Take the tour$/i })).toBeVisible()
  await continueOnboarding(page)
  await expect(page.getByText(/Available later under Help > Explore Orca/i)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
  await expect(page.getByText('7 of 7')).toBeVisible()
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
    await expect(orcaPage.getByText('1 of 7')).toBeVisible()
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
    await expect(orcaPage.getByText('2 of 7')).toBeVisible()
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
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await expect(orcaPage.getByText('3 of 7')).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance to 2 after second Continue'
      })
      .toBe(2)
    await expect
      .poll(async () => (await getSettings(orcaPage)).theme, { timeout: 5_000 })
      .toBe(oppositeTheme)

    // --- Step 3: notifications ---
    await expectOnboardingNotificationSound(orcaPage, /System Default/i)
    await expect(orcaPage.getByRole('button', { name: /Send Test Notification/i })).toBeVisible()
    await expectOnboardingCustomSoundOption(orcaPage)
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up Orca for agents/i })).toBeVisible()
    await expect(orcaPage.getByText('4 of 7')).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000,
        message: 'lastCompletedStep did not advance to 3 after notifications Continue'
      })
      .toBe(3)

    // Why: the feature checklist defaults ON; inject safe deps so this E2E
    // validates setup without registering the real CLI or opening OS prompts.
    await installSafeOnboardingFeatureSetupDeps(orcaPage)
    const browserUse = orcaPage.getByRole('checkbox', { name: /Agent Browser Use/i })
    const computerUse = orcaPage.getByRole('checkbox', { name: /Computer Use/i })
    const orchestration = orcaPage.getByRole('checkbox', { name: /Agent Orchestration/i })
    await expect(browserUse).toHaveAttribute('aria-checked', 'true')
    await expect(computerUse).toHaveAttribute('aria-checked', 'true')
    await expect(orchestration).toHaveAttribute('aria-checked', 'true')

    await setupOnboardingFeatures(orcaPage)
    await expectSkillSetupTerminalReady(orcaPage)
    await expect(onboardingFooterButton(orcaPage, /^Continue\b/)).toBeVisible()
    await continueFromFeatureSetupToRepo(orcaPage)
    await expect(orcaPage.getByRole('button', { name: /Open a folder/i })).toBeVisible()
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(6)
    // Why: the E2E fixture starts with a seeded project, so the repo step can
    // complete onboarding through its existing-project Continue action.
    await expect(onboardingFooterButton(orcaPage, /^Continue\b/)).toBeVisible()

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
        async () =>
          orcaPage.evaluate(
            ({ orchestrationKey, browserUseKey }) => ({
              orchestration: localStorage.getItem(orchestrationKey),
              browserUse: localStorage.getItem(browserUseKey)
            }),
            {
              orchestrationKey: ORCHESTRATION_ENABLED_STORAGE_KEY,
              browserUseKey: BROWSER_USE_ENABLED_STORAGE_KEY
            }
          ),
        { timeout: 5_000 }
      )
      .toEqual({ orchestration: '1', browserUse: '1' })

    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toHaveCount(0)
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
        addedRepo: true,
        lastCompletedStep: 7
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

  test('Skip jumps to the repo step, saves the selected agent, and keeps onboarding open', async ({
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

    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    await expect(orcaPage.getByText('7 of 7')).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    await expect(onboardingFooterButton(orcaPage, /Skip all onboarding/i)).toHaveCount(0)
    await expect(orcaPage.getByRole('button', { name: /Open a folder/i })).toBeVisible()
    await expect(
      orcaPage.getByRole('button', { name: /SSH\? Set hosts up in Settings/i })
    ).toBeVisible()

    await expect
      .poll(
        async () => {
          const state = await getOnboardingState(orcaPage)
          return {
            closedAt: state.closedAt,
            outcome: state.outcome,
            dismissed: state.checklist.dismissed,
            lastCompletedStep: state.lastCompletedStep
          }
        },
        { timeout: 5_000 }
      )
      .toEqual({
        closedAt: null,
        outcome: null,
        dismissed: false,
        lastCompletedStep: 6
      })
    await expect
      .poll(async () => (await getSettings(orcaPage)).defaultTuiAgent, { timeout: 5_000 })
      .toBe('codex')

    await orcaPage.reload()
    await waitForSessionReady(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    await expect(orcaPage.getByText('7 of 7')).toBeVisible()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    expect((await getOnboardingState(orcaPage)).closedAt).toBeNull()
  })

  test('SSH settings link opens settings without dismissing onboarding', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()

    await orcaPage.getByRole('button', { name: /SSH\? Set hosts up in Settings/i }).click()

    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toHaveCount(0)
    await expect(
      orcaPage
        .locator('[data-settings-section="ssh"]')
        .getByRole('heading', { name: 'SSH Hosts', exact: true })
    ).toBeInViewport({ timeout: 10_000 })
    await expect(
      orcaPage.locator('[data-settings-section="ssh"]').getByRole('button', { name: /Add Target/i })
    ).toBeVisible()
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
        closedAt: null,
        outcome: null,
        dismissed: false,
        lastCompletedStep: 6
      })

    await orcaPage.keyboard.press('Escape')
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    await expect(orcaPage.getByText('7 of 7')).toBeVisible()
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

    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
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

    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    await expect(orcaPage.getByText('Runtime server', { exact: true })).toBeVisible()
    await expect(orcaPage.getByText('Server paths only')).toBeVisible()
    await expect(orcaPage.getByText('Open a server project')).toBeVisible()
    await expect(orcaPage.getByPlaceholder('/home/user/project')).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /Add Git Project/i })).toBeDisabled()
    await expect(orcaPage.getByRole('button', { name: /Open as Folder/i })).toBeDisabled()
    await orcaPage
      .getByPlaceholder('git@github.com:org/repo.git')
      .fill('git@github.com:org/repo.git')
    await expect(orcaPage.getByRole('button', { name: /^Clone$/i })).toBeDisabled()
    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    expect((await getOnboardingState(orcaPage)).closedAt).toBeNull()
  })

  test('Skip from notifications does not request permission or run feature setup', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()

    await orcaPage.evaluate(() => {
      localStorage.removeItem('orca.e2e.notificationPermissionRequested')
      window.api.notifications.requestPermission = async () => {
        localStorage.setItem('orca.e2e.notificationPermissionRequested', '1')
        return { supported: true, platform: 'darwin', requested: true }
      }
    })
    await expectOnboardingNotificationSound(orcaPage, /System Default/i)

    await onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON).click()

    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            ({ orchestrationKey, browserUseKey }) => ({
              orchestration: localStorage.getItem(orchestrationKey),
              browserUse: localStorage.getItem(browserUseKey)
            }),
            {
              orchestrationKey: ORCHESTRATION_ENABLED_STORAGE_KEY,
              browserUseKey: BROWSER_USE_ENABLED_STORAGE_KEY
            }
          ),
        { timeout: 5_000 }
      )
      .toEqual({ orchestration: null, browserUse: null })
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
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()

    await chooseOnboardingNotificationSound(orcaPage, /^Ding$/i)

    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up Orca for agents/i })).toBeVisible()
    await installSafeOnboardingFeatureSetupDeps(orcaPage)
    await setupOnboardingFeatures(orcaPage)
    await expect(orcaPage.getByRole('region', { name: /Skill setup command/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: TASK_SOURCES_HEADING })).toBeVisible()
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

  test('can opt into orchestration setup without enabling browser or computer use', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up Orca for agents/i })).toBeVisible()

    // Why: this flow validates the orchestration-only setup path without
    // touching Browser Use, Computer Use permission prompts, or real CLI mutation.
    await orcaPage.evaluate(() => {
      window.__onboardingFeatureSetupDeps = {
        getCliStatus: async () => ({
          platform: 'darwin',
          commandName: 'orca',
          commandPath: '/usr/local/bin/orca',
          pathDirectory: '/usr/local/bin',
          pathConfigured: true,
          launcherPath: '/Applications/Orca.app/Contents/MacOS/Orca',
          installMethod: 'symlink',
          supported: true,
          state: 'installed',
          currentTarget: '/Applications/Orca.app/Contents/MacOS/Orca',
          unsupportedReason: null,
          detail: null
        }),
        installCli: async () => {
          throw new Error('CLI registration should not run in this onboarding E2E')
        },
        writeClipboardText: async () => undefined,
        getComputerUsePermissionStatus: async () => {
          throw new Error('Computer Use permissions should stay untouched')
        },
        openComputerUsePermissionSetup: async () => {
          throw new Error('Computer Use setup should stay untouched')
        },
        setStorageItem: (key, value) => localStorage.setItem(key, value),
        removeStorageItem: (key) => localStorage.removeItem(key),
        notifyOrchestrationStateChanged: () => {
          window.dispatchEvent(new CustomEvent('orca:orchestration-setup-state'))
        }
      }
    })

    const browserUse = orcaPage.getByRole('checkbox', { name: /Agent Browser Use/i })
    const computerUse = orcaPage.getByRole('checkbox', { name: /Computer Use/i })
    const orchestration = orcaPage.getByRole('checkbox', { name: /Agent Orchestration/i })
    await expect(browserUse).toHaveAttribute('aria-checked', 'true')
    await expect(computerUse).toHaveAttribute('aria-checked', 'true')
    await expect(orchestration).toHaveAttribute('aria-checked', 'true')

    await browserUse.click()
    await computerUse.click()
    await expect(browserUse).toHaveAttribute('aria-checked', 'false')
    await expect(computerUse).toHaveAttribute('aria-checked', 'false')
    await expect(orchestration).toHaveAttribute('aria-checked', 'true')

    await setupOnboardingFeatures(orcaPage)
    await expect(orcaPage.getByRole('region', { name: /Skill setup command/i })).toBeVisible()
    await continueFromFeatureSetupToRepo(orcaPage)
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(6)
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            ({ orchestrationKey, browserUseKey }) => ({
              orchestration: localStorage.getItem(orchestrationKey),
              browserUse: localStorage.getItem(browserUseKey)
            }),
            {
              orchestrationKey: ORCHESTRATION_ENABLED_STORAGE_KEY,
              browserUseKey: BROWSER_USE_ENABLED_STORAGE_KEY
            }
          ),
        { timeout: 5_000 }
      )
      .toEqual({ orchestration: '1', browserUse: '0' })
  })

  test('typing in the clone-url input does not hijack Enter as a global shortcut', async ({
    orcaPage
  }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })
    // Advance to the repo step.
    await continueOnboarding(orcaPage)
    await continueOnboarding(orcaPage)
    await continueOnboarding(orcaPage)
    await installSafeOnboardingFeatureSetupDeps(orcaPage)
    await setupOnboardingFeatures(orcaPage)
    await expectSkillSetupTerminalReady(orcaPage)
    await continueFromFeatureSetupToRepo(orcaPage)

    // Why: focus the clone-url input and press Cmd/Ctrl+Enter. The capture-
    // phase keydown handler should bail via isEditableTarget, so the folder
    // picker IPC must NOT fire (the heading should remain visible — no
    // navigation, no opened OS dialog). A bare Enter press also must not
    // submit the empty form (the Clone button is disabled when blank).
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const accelerator = isMac ? 'Meta+Enter' : 'Control+Enter'
    const input = orcaPage.getByPlaceholder('git@github.com:org/repo.git')
    await input.click()
    await input.press(accelerator)
    // Brief wait so any (incorrect) handler firing would have already happened.
    await orcaPage.waitForTimeout(250)
    await expect(orcaPage.getByRole('heading', { name: REPO_STEP_HEADING })).toBeVisible()
    // Onboarding must still be open (closedAt remains null).
    expect((await getOnboardingState(orcaPage)).closedAt).toBeNull()
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
    await expect(orcaPage.getByText('1 of 7')).toBeVisible()

    // Why: "without losing progress" means persisted lastCompletedStep stays
    // at 1 — Back rewinds the visible step but must not roll persistence back.
    // Poll because persistence flushes async via IPC after the Back click.
    await expect
      .poll(async () => (await getOnboardingState(orcaPage)).lastCompletedStep, {
        timeout: 5_000
      })
      .toBe(1)
  })

  test('repo step does not offer a skip or dismiss action', async ({ orcaPage }) => {
    await expect(orcaPage.getByRole('heading', { name: /Pick your default agent/i })).toBeVisible({
      timeout: 15_000
    })

    // Advance through the optional setup and tour steps. The repo step is required setup,
    // so the footer must not offer a dismiss action there.
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Make it feel like home/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up notifications/i })).toBeVisible()
    await continueOnboarding(orcaPage)
    await expect(orcaPage.getByRole('heading', { name: /Set up Orca for agents/i })).toBeVisible()
    await installSafeOnboardingFeatureSetupDeps(orcaPage)
    await setupOnboardingFeatures(orcaPage)
    await expectSkillSetupTerminalReady(orcaPage)
    await continueFromFeatureSetupToRepo(orcaPage)

    await expect(onboardingFooterButton(orcaPage, SKIP_TO_PROJECT_SETUP_BUTTON)).toHaveCount(0)
    await expect(onboardingFooterButton(orcaPage, /Skip all onboarding/i)).toHaveCount(0)
    const final = await getOnboardingState(orcaPage)
    expect(final.closedAt).toBeNull()
    expect(final.outcome).toBeNull()
    expect(final.checklist.dismissed).toBe(false)
    expect(final.lastCompletedStep).toBe(6)
  })
})
