import { randomUUID } from 'node:crypto'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { runProcessSync } from '../../src/shared/child-process/run-process'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { test, expect } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { waitForSessionReady } from './helpers/store'

const BUNDLE_ID = 'com.if.Amphetamine'
const REAL_AMPHETAMINE_OPTED_IN = process.env.ORCA_E2E_REAL_AMPHETAMINE === 'dedicated-account'

type CleanupOutcome = 'ended' | 'foreign' | 'gone'
type CleanupSession = 'timed-fixture'

function amphetamine(script: string): string {
  const result = runProcessSync({
    program: '/usr/bin/osascript',
    args: ['-e', script],
    timeoutMs: 10_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Amphetamine AppleScript failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`
    )
  }
  return result.stdout.trim()
}

function amphetamineInstalled(): boolean {
  try {
    return amphetamine(`POSIX path of (path to application id "${BUNDLE_ID}")`).length > 0
  } catch {
    return false
  }
}

const AMPHETAMINE_INSTALLED =
  process.platform === 'darwin' && REAL_AMPHETAMINE_OPTED_IN ? amphetamineInstalled() : false

/** presence|secondsRemaining|isTrigger|displaySleepAllowed */
function readSession(): string {
  return amphetamine(`if application id "${BUNDLE_ID}" is running then
	tell application id "${BUNDLE_ID}"
		if session is active then
			return "active|" & (session time remaining) & "|" & (session is Trigger) & "|" & (display sleep allowed)
		end if
		return "idle|-3|false|false"
	end tell
else
	return "absent|-3|false|false"
end if`)
}

function isTimedFixtureSession(state: string): boolean {
  const [presence, secondsText, trigger, displaySleep] = state.split('|')
  const secondsRemaining = Number.parseInt(secondsText ?? '', 10)
  return (
    presence === 'active' &&
    secondsRemaining > 0 &&
    secondsRemaining <= 1800 &&
    trigger === 'false' &&
    displaySleep === 'false'
  )
}

function requireIdleAmphetamine(): void {
  const state = readSession()
  expect(
    state === 'idle|-3|false|false' || state === 'absent|-3|false|false',
    'Amphetamine already has an active session; use a dedicated idle account'
  ).toBe(true)
}

function startTimedFixture(): string {
  return amphetamine(`tell application id "${BUNDLE_ID}"
	if session is active then return "busy"
	start new session with options {duration:30, interval:minutes, displaySleepAllowed:false}
	return "started"
end tell`)
}

/** Shape narrows cleanup risk but cannot prove identity; Amphetamine exposes none. */
function cleanupTimedFixture(): CleanupOutcome {
  const outcome = amphetamine(`if application id "${BUNDLE_ID}" is running then
	tell application id "${BUNDLE_ID}"
		if not (session is active) then return "gone"
		set secondsRemaining to (session time remaining)
		set triggerSession to (session is Trigger)
		set allowsDisplaySleep to (display sleep allowed)
		if triggerSession then return "foreign"
		if secondsRemaining is less than or equal to 0 then return "foreign"
		if secondsRemaining is greater than 1800 then return "foreign"
		if allowsDisplaySleep then return "foreign"
		end session
		return "ended"
	end tell
else
	return "gone"
end if`)
  if (outcome === 'ended' || outcome === 'foreign' || outcome === 'gone') {
    return outcome
  }
  throw new Error(`Unexpected Amphetamine cleanup outcome: ${outcome}`)
}

async function selectAmphetamineIntegration(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const next = await window.api.settings.set({
      computerAwakeMacosEngine: 'amphetamine',
      computerAwakeMode: 'auto',
      keepComputerAwakeWhileAgentsRun: true
    })
    window.__store?.setState({ settings: next as GlobalSettings })
  })
}

async function postCodexHookEvent(
  electronApp: ElectronApplication,
  paneKey: string,
  eventName: 'UserPromptSubmit' | 'Stop'
): Promise<void> {
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey,
      tabId: 'e2e-amphetamine-tab',
      worktreeId: 'e2e-amphetamine-worktree',
      env: endpoint.env,
      version: endpoint.version,
      payload: { hook_event_name: eventName, prompt: 'e2e amphetamine prompt' }
    })
  })
  expect(response.status).toBe(204)
}

test.describe('Amphetamine keep-awake observation', () => {
  test.describe.configure({ mode: 'serial' })
  test.skip(process.platform !== 'darwin', 'requires macOS')
  test.skip(
    !REAL_AMPHETAMINE_OPTED_IN,
    'set ORCA_E2E_REAL_AMPHETAMINE=dedicated-account on a dedicated macOS account'
  )
  test.skip(
    process.platform === 'darwin' && REAL_AMPHETAMINE_OPTED_IN && !AMPHETAMINE_INSTALLED,
    'requires Amphetamine to be installed on the test host'
  )

  let cleanupSession: CleanupSession | null = null

  test.beforeEach(() => {
    cleanupSession = null
  })

  test.afterEach(() => {
    if (!cleanupSession) {
      return
    }
    const outcome = cleanupTimedFixture()
    if (outcome === 'ended') {
      cleanupSession = null
    }
    expect(
      outcome,
      'The timed fixture disappeared or changed shape; it was not ended by cleanup'
    ).toBe('ended')
  })

  test('observes but never mutates a real timed session', async ({ electronApp, orcaPage }) => {
    await waitForSessionReady(orcaPage)
    requireIdleAmphetamine()
    const startOutcome = startTimedFixture()
    expect(startOutcome, 'Amphetamine became active before the fixture started').toBe('started')
    cleanupSession = 'timed-fixture'
    await expect
      .poll(() => isTimedFixtureSession(readSession()), {
        timeout: 15_000,
        message: 'Amphetamine did not start the timed fixture session'
      })
      .toBe(true)

    await selectAmphetamineIntegration(orcaPage)
    const caffeinateInactive = orcaPage.getByRole('button', {
      name: 'Caffeinate, Agent · Inactive'
    })
    await expect(caffeinateInactive).toBeVisible({ timeout: 15_000 })

    const firstPaneKey = `e2e-amphetamine-tab:${randomUUID()}`
    await postCodexHookEvent(electronApp, firstPaneKey, 'UserPromptSubmit')
    const combinedActive = orcaPage.getByRole('button', {
      name: 'Caffeinate + Amphetamine, Agent · Active'
    })
    await expect(combinedActive).toBeVisible({ timeout: 15_000 })
    expect(
      isTimedFixtureSession(readSession()),
      'Orca replaced or ended the timed Amphetamine session while observing it'
    ).toBe(true)

    await postCodexHookEvent(electronApp, firstPaneKey, 'Stop')
    await expect(caffeinateInactive).toBeVisible({ timeout: 15_000 })
    expect(
      isTimedFixtureSession(readSession()),
      'Orca ended the timed Amphetamine session when the agent stopped'
    ).toBe(true)

    const secondPaneKey = `e2e-amphetamine-tab:${randomUUID()}`
    await postCodexHookEvent(electronApp, secondPaneKey, 'UserPromptSubmit')
    await expect(combinedActive).toBeVisible({ timeout: 15_000 })

    const cleanupOutcome = cleanupTimedFixture()
    if (cleanupOutcome === 'ended') {
      cleanupSession = null
    }
    expect(cleanupOutcome).toBe('ended')

    const caffeinateActive = orcaPage.getByRole('button', {
      name: 'Caffeinate, Agent · Active'
    })
    await expect(caffeinateActive).toBeVisible({ timeout: 45_000 })

    await postCodexHookEvent(electronApp, secondPaneKey, 'Stop')
    await expect(caffeinateInactive).toBeVisible({ timeout: 15_000 })
  })
})
