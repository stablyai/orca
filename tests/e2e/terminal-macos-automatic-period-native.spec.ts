import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
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

const ABC_ID = 'com.apple.keylayout.ABC'
const KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'

function typePhysicalKeys(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat with currentKeyCode in {${keyCodes.join(', ')}}`,
    '-e',
    'key code (currentKeyCode as integer)',
    '-e',
    'delay 0.1',
    '-e',
    'end repeat',
    '-e',
    'end tell'
  ])
}

async function waitForInputSource(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.api.app.getKeyboardInputSourceId()))
    .toBe(expected)
}

test.describe('Native macOS automatic period substitution @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_PERIOD !== '1',
    'Requires explicit native macOS period-substitution evidence mode'
  )

  test('records Hangul word-boundary and ABC punctuation streams', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const hangulReader = createTerminalImeByteReader(testRepoPath, 1)
    const abcReader = createTerminalImeByteReader(testRepoPath, 1)
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, hangulReader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)
      execFileSync('swift', ['tests/e2e/select-input-source.swift', KOREAN_ID])
      await waitForInputSource(orcaPage, KOREAN_ID)

      typePhysicalKeys(electronApp.process().pid!, [2, 40, 49])
      await orcaPage.waitForTimeout(500)
      const hangulBeforeEnter = await readTerminalImeBoundaryTrace(orcaPage)
      expect(hangulBeforeEnter.onData.join('')).toBe('아 ')
      typePhysicalKeys(electronApp.process().pid!, [36])
      const hangulPty = await waitForTerminalImeBytes(orcaPage, hangulReader)

      await startTerminalImeByteReader(orcaPage, ptyId, abcReader)
      await focusActiveTerminalInput(orcaPage)

      execFileSync('swift', ['tests/e2e/select-input-source.swift', ABC_ID])
      await waitForInputSource(orcaPage, ABC_ID)
      typePhysicalKeys(electronApp.process().pid!, [47, 49, 36])

      const abcPty = await waitForTerminalImeBytes(orcaPage, abcReader)
      expect([hangulPty[0], abcPty[0]]).toEqual([
        Buffer.from('아 \n').toString('hex'),
        Buffer.from('. \n').toString('hex')
      ])
      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(trace.onData.join('')).toBe('아 \r. \r')
      await attachTerminalImeBoundaryEvidence(
        orcaPage,
        testInfo,
        'native-macos-automatic-period-boundaries',
        { abcPty, automaticPeriodPreference: true, hangulBeforeEnter, hangulPty }
      )
    } finally {
      execFileSync('swift', ['tests/e2e/select-input-source.swift', ABC_ID])
      await disposeTerminalImeBoundaryProbe(orcaPage).catch(() => undefined)
      removeTerminalImeByteReader(hangulReader)
      removeTerminalImeByteReader(abcReader)
    }
  })
})
