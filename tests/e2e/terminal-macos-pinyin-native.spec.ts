import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
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

const ABC_ID = 'com.apple.keylayout.ABC'
const PINYIN_ID = 'com.apple.inputmethod.SCIM.ITABC'
const RECORDED_PINYIN_CANCEL_BOUNDARIES = {
  initial: {
    type: 'keydown',
    key: 'c',
    code: 'KeyC',
    keyCode: 229,
    isComposing: false
  },
  final: [
    { type: 'keydown', key: 'Backspace', keyCode: 229, isComposing: true },
    { type: 'compositionupdate', data: '' },
    { type: 'input', data: null, inputType: 'deleteContentBackward', isComposing: false },
    { type: 'compositionend', data: '' }
  ]
} as const

function typeKeyCodes(processId: number, keyCodes: readonly number[]): void {
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

function selectInputSource(inputSourceId: string): void {
  execFileSync('swift', ['tests/e2e/select-input-source.swift', inputSourceId])
}

async function readActiveComposition(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

test.describe('Native macOS Pinyin terminal input @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_PINYIN !== '1',
    'Requires macOS with built-in Pinyin selected and Accessibility access'
  )

  test('cancels deleted preedit without leaking its first key', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect(orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
      PINYIN_ID
    )

    const ptyId = await waitForActivePanePtyId(orcaPage)
    // The line count MUST stay 1. The cancel arm emits nothing, so it cannot be asserted at the PTY
    // directly; instead the single captured line is the FIRST thing to reach the PTY child, and a
    // leaked cancel key (which carries no newline) would prepend to it — `cordinary\n` rather than
    // `ordinary\n`. That prefix property is what enforces "nothing leaked" at the byte boundary.
    // Raising this count, or sending anything newline-terminated before the control, silently
    // downgrades the assertion to "the control worked" with no test failure to signal it.
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)
      typeKeyCodes(electronApp.process().pid!, [8, 14, 1, 4, 34])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe('ce shi')

      typeKeyCodes(electronApp.process().pid!, [51, 51, 51, 51, 51])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe(null)
      const cancelTrace = await readTerminalImeBoundaryTrace(orcaPage)
      const boundaries = cancelTrace.dom.filter((event) =>
        ['keydown', 'compositionupdate', 'input', 'compositionend'].includes(event.type)
      )
      expect(boundaries[0]).toMatchObject(RECORDED_PINYIN_CANCEL_BOUNDARIES.initial)
      expect(boundaries.slice(-4)).toMatchObject(RECORDED_PINYIN_CANCEL_BOUNDARIES.final)
      expect(cancelTrace.onData).toEqual([])

      selectInputSource(ABC_ID)
      await expect
        .poll(() => orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId()))
        .toBe(ABC_ID)
      await orcaPage.keyboard.type('ordinary')
      await orcaPage.keyboard.press('Enter')

      expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
        Buffer.from('ordinary\n').toString('hex')
      ])
      expect((await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')).toBe('ordinary\r')
      completed = true
    } finally {
      await attachTerminalImeBoundaryEvidence(orcaPage, testInfo, 'native-macos-pinyin').catch(
        () => undefined
      )
      await disposeTerminalImeBoundaryProbe(orcaPage).catch(() => undefined)
      if (!completed) {
        await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
      }
      removeTerminalImeByteReader(reader)
      selectInputSource(ABC_ID)
    }
  })
})
