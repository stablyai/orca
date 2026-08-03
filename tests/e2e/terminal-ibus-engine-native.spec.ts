import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  resolveNativeIbusEngineInputProfile,
  type NativeIbusEngineInputProfile,
  type NativeIbusEngineScenario,
  type NativeIbusInputDriver
} from './terminal-ibus-engine-input-profiles'
import {
  attachTerminalImeBoundaryEvidence,
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

const DEFAULT_REPETITIONS = 30
const MAX_REPETITIONS = 30
const DEFAULT_KEY_DELAY_MS = 1
const MAX_KEY_DELAY_MS = 100
const NATIVE_COMMAND_TIMEOUT_MS = 10_000

const engineId = process.env.ORCA_E2E_NATIVE_IBUS_ENGINE
const profile = resolveNativeIbusEngineInputProfile(engineId)

test.use({
  orcaAppExtraEnv: {
    GTK_IM_MODULE: 'ibus',
    IBUS_ENABLE_SYNC_MODE: '1',
    QT_IM_MODULE: 'ibus',
    XMODIFIERS: '@im=ibus'
  }
})

function nativeRepetitions(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_REPETITIONS ?? DEFAULT_REPETITIONS)
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_REPETITIONS)
    : DEFAULT_REPETITIONS
}

function nativeKeyDelayMs(): number {
  const parsed = Number(process.env.ORCA_E2E_NATIVE_IBUS_KEY_DELAY_MS ?? DEFAULT_KEY_DELAY_MS)
  return Number.isInteger(parsed) && parsed >= 0
    ? Math.min(parsed, MAX_KEY_DELAY_MS)
    : DEFAULT_KEY_DELAY_MS
}

function runXdotool(...args: string[]): void {
  execFileSync('xdotool', args, { stdio: 'pipe', timeout: NATIVE_COMMAND_TIMEOUT_MS })
}

function createInputDriver(): NativeIbusInputDriver {
  const delay = String(nativeKeyDelayMs())
  return {
    key: (keyName) => runXdotool('key', keyName),
    type: (text) => runXdotool('type', '--delay', delay, text),
    typeClearingModifiers: (text) => runXdotool('type', '--delay', delay, '--clearmodifiers', text)
  }
}

async function focusNativeTerminalWindow(
  page: Page,
  engine: NativeIbusEngineInputProfile
): Promise<string> {
  await focusActiveTerminalInput(page)
  const title = `ORCA_NATIVE_IBUS_${randomUUID()}`
  await page.evaluate((nextTitle) => {
    document.title = nextTitle
  }, title)
  await expect.poll(() => page.title(), { timeout: 5_000 }).toBe(title)

  runXdotool('search', '--onlyvisible', '--name', title, 'windowfocus', '--sync')
  try {
    execFileSync('ibus', ['engine', engine.ibusEngineName], {
      stdio: 'pipe',
      timeout: NATIVE_COMMAND_TIMEOUT_MS
    })
  } catch {
    // Why: selection succeeds over D-Bus before the non-zero exit an engine with no
    // XKB layout of its own produces; the read-back below is the real assertion.
  }
  const active = execFileSync('ibus', ['engine'], {
    encoding: 'utf8',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  }).trim()
  expect(active).toBe(engine.ibusEngineName)
  return title
}

async function runNativeIbusScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  engine: NativeIbusEngineInputProfile,
  scenario: NativeIbusEngineScenario
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const repetitions = nativeRepetitions()
  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, repetitions)
  const driver = createInputDriver()
  let completed = false
  let receivedBytes: string[] = []
  let observedText = ''
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusNativeTerminalWindow(page, engine)
    await installTerminalImeBoundaryProbe(page)
    for (let index = 0; index < repetitions; index += 1) {
      scenario.drive(driver)
    }

    receivedBytes = await waitForTerminalImeBytes(page, reader, 30_000)
    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.dom.some((event) => event.type === 'compositionstart')).toBe(true)
    expect(
      trace.dom.some(
        (event) =>
          (event.type === 'compositionupdate' ||
            (event.type === 'input' && event.inputType === 'insertText')) &&
          engine.committedScriptPattern.test(event.data ?? '')
      )
    ).toBe(true)

    // Engine-independent oracle: identical bytes every repetition, in the
    // engine's script, and xterm emitted exactly what the PTY received. This
    // holds even where the glyphs depend on a dictionary.
    const [firstLine = ''] = receivedBytes
    expect(receivedBytes).toEqual(Array.from({ length: repetitions }, () => firstLine))
    observedText = Buffer.from(firstLine, 'hex').toString('utf8').replace(/\n$/, '')
    expect(observedText).toMatch(engine.committedScriptPattern)
    expect(trace.onData.join('')).toBe(`${observedText}\r`.repeat(repetitions))

    // Exact oracle. Soft for engines whose expected text is still a prediction,
    // so one observational run reports the structural verdict and the real text.
    const assertExpectedText = engine.expectationsVerified ? expect : expect.soft
    assertExpectedText(observedText).toBe(scenario.expectedText)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-ibus-boundaries', {
      display: process.env.DISPLAY,
      engine: engine.ibusEngineName,
      expectationsVerified: engine.expectationsVerified,
      expectedText: scenario.expectedText,
      keyDelayMs: nativeKeyDelayMs(),
      observedText,
      receivedBytes,
      repetitions
    }).catch(() => undefined)
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

test.describe(`Native IBus ${profile?.ibusEngineName ?? 'engine'} terminal input @headful`, () => {
  test.skip(!profile, 'Run through config/scripts/run-terminal-ibus-engine-e2e.mjs')

  if (!profile) {
    test('is driven by the native IBus engine runner', () => {})
    return
  }

  for (const scenario of profile.scenarios) {
    test(scenario.title, async ({ orcaPage, testRepoPath }, testInfo) => {
      await runNativeIbusScenario(orcaPage, testInfo, testRepoPath, profile, scenario)
    })
  }
})
