import { execFileSync } from 'node:child_process'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
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

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'

function typeNativeTwoSetKorean(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    `tell application "System Events" to key code {${keyCodes.join(', ')}}`
  ])
}

async function runNativeScenario(
  page: Page,
  testInfo: TestInfo,
  testRepoPath: string,
  processId: number,
  keyCodes: readonly number[],
  expectedText: string
): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await expect(page.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
    TWO_SET_KOREAN_ID
  )

  const ptyId = await waitForActivePanePtyId(page)
  const reader = createTerminalImeByteReader(testRepoPath, 1)
  let completed = false
  try {
    await startTerminalImeByteReader(page, ptyId, reader)
    await focusActiveTerminalInput(page)
    await installTerminalImeBoundaryProbe(page)
    typeNativeTwoSetKorean(processId, keyCodes)

    const receivedBytes = await waitForTerminalImeBytes(page, reader)
    expect(receivedBytes).toEqual([Buffer.from(`${expectedText}\n`).toString('hex')])
    const trace = await readTerminalImeBoundaryTrace(page)
    expect(trace.onData.join('')).toBe(`${expectedText}\r`)
    completed = true
  } finally {
    await attachTerminalImeBoundaryEvidence(page, testInfo, 'native-macos-2set-boundaries').catch(
      () => undefined
    )
    await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
    if (!completed) {
      await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
    }
    removeTerminalImeByteReader(reader)
  }
}

test.describe('Native macOS 2-Set Korean terminal input @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with 2-Set Korean selected and Accessibility access'
  )

  test('forwards physical Hangul input as exact PTY bytes', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [5, 40, 1, 15, 46, 3, 36],
      '한글'
    )
  })

  test('preserves leading vowels and composes the following syllable', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await runNativeScenario(
      orcaPage,
      testInfo,
      testRepoPath,
      electronApp.process().pid!,
      [31, 40, 0, 16, 36],
      'ㅐㅏ묘'
    )
  })
})
