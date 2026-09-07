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
import { appendImeEngagementReceipt } from './terminal-ime-engagement-receipt'

const DEFAULT_REPETITIONS = 30
const MAX_REPETITIONS = 30
const DEFAULT_KEY_DELAY_MS = 1
const MAX_KEY_DELAY_MS = 100
const NATIVE_COMMAND_TIMEOUT_MS = 10_000

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

async function focusNativeTerminalWindow(page: Page): Promise<string> {
  await focusActiveTerminalInput(page)
  const title = `ORCA_NATIVE_IBUS_${randomUUID()}`
  await page.evaluate((nextTitle) => {
    document.title = nextTitle
  }, title)
  await expect.poll(() => page.title(), { timeout: 5_000 }).toBe(title)

  runXdotool('search', '--onlyvisible', '--name', title, 'windowfocus', '--sync')
  execFileSync('ibus', ['engine', 'hangul'], {
    stdio: 'pipe',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  })
  const engine = execFileSync('ibus', ['engine'], {
    encoding: 'utf8',
    timeout: NATIVE_COMMAND_TIMEOUT_MS
  }).trim()
  expect(engine).toBe('hangul')
  return title
}

function typeExactByteSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool('type', '--delay', delay, '--clearmodifiers', 'gks')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'abc')
    runXdotool('key', 'Hangul')
    runXdotool('type', '--delay', delay, 'rmf')
    runXdotool('key', 'Return')
  }
}

function typeSentenceSequence(repetitions: number): void {
  const delay = String(nativeKeyDelayMs())
  for (let index = 0; index < repetitions; index += 1) {
    runXdotool(
      'type',
      '--delay',
      delay,
      '--clearmodifiers',
      'xptmxmfmf gkrh dlTsmsep duwjsgl rmfjsp'
    )
    runXdotool('key', 'Return')
  }
}

async function runNativeIbusScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  expectedText: string,
  driveInput: (repetitions: number) => void
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)

  const repetitions = nativeRepetitions()
  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, repetitions)
  let completed = false
  let receivedBytes: string[] = []
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusNativeTerminalWindow(page)
    await installTerminalImeBoundaryProbe(page)
    driveInput(repetitions)

    receivedBytes = await waitForTerminalImeBytes(page, reader, 30_000)
    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.dom.some((event) => event.type === 'compositionstart')).toBe(true)
    expect(
      trace.dom.some(
        (event) =>
          (event.type === 'compositionupdate' ||
            (event.type === 'input' && event.inputType === 'insertText')) &&
          /[\uac00-\ud7af]/.test(event.data ?? '')
      )
    ).toBe(true)

    const expectedBytes = Buffer.from(`${expectedText}\n`).toString('hex')
    expect(receivedBytes).toEqual(Array.from({ length: repetitions }, () => expectedBytes))

    expect(trace.onData.join('')).toBe(`${expectedText}\r`.repeat(repetitions))
    // Why after the assertions: the receipt is the runner's proof this test ran against a live
    // engine, so it must not exist for a run that reached here with the bytes wrong.
    appendImeEngagementReceipt(testInfo.title, trace)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-ibus-boundaries', {
      display: process.env.DISPLAY,
      expectedText,
      keyDelayMs: nativeKeyDelayMs(),
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

test.describe('Native IBus Hangul terminal input @headful', () => {
  test.skip(
    process.env.ORCA_E2E_NATIVE_IBUS_HANGUL !== '1',
    'Run through config/scripts/run-terminal-ibus-hangul-e2e.mjs'
  )

  test('forwards the issue exact-byte sequence without loss or duplication', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(orcaPage, testInfo, testRepoPath, '한abc글', typeExactByteSequence)
  })

  test('forwards the issue sentence stress sequence without leaked ASCII', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeIbusScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      '테스트를 하고 있는데 여전히 그러네',
      typeSentenceSequence
    )
  })
})
