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
import { resolveInputSourceId } from './macos-input-source-resolver'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

const ABC_ID = 'com.apple.keylayout.ABC'
// Apple ships Cangjie under both bundle IDs — this host has TCIM.Cangjie and TYIM.Cangjie
// installed simultaneously. Resolved lazily so collection on non-darwin never shells out to swift.
const CANGJIE_CANDIDATES = [
  'com.apple.inputmethod.TCIM.Cangjie',
  'com.apple.inputmethod.TYIM.Cangjie'
] as const
let resolvedCangjieId: string | null = null
const cangjieInputSourceId = (): string =>
  (resolvedCangjieId ??= resolveInputSourceId('cangjie', CANGJIE_CANDIDATES))
const RECORDED_CANGJIE_CANCEL_BOUNDARIES = [
  { type: 'keydown', key: '尸', code: 'KeyS', keyCode: 229, isComposing: false },
  { type: 'compositionstart', data: '' },
  { type: 'compositionupdate', data: '尸' },
  { type: 'beforeinput', data: '尸', inputType: 'insertCompositionText', isComposing: true },
  {
    type: 'input',
    data: '尸',
    inputType: 'insertCompositionText',
    isComposing: true,
    value: '尸'
  },
  { type: 'keyup', key: '尸', keyCode: 83, isComposing: true },
  { type: 'keydown', key: 'Backspace', keyCode: 229, isComposing: true },
  { type: 'compositionupdate', data: '' },
  { type: 'beforeinput', data: '', inputType: 'insertCompositionText', isComposing: true },
  {
    type: 'input',
    data: null,
    inputType: 'deleteContentBackward',
    isComposing: false,
    value: ''
  },
  { type: 'compositionend', data: '' },
  { type: 'keyup', key: 'Backspace', keyCode: 8, isComposing: false }
] as const

function typeKeyCodes(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    `tell application "System Events" to key code {${keyCodes.join(', ')}}`
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

test.describe('Native macOS Cangjie terminal input @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_CANGJIE !== '1',
    'Requires macOS with built-in Cangjie selected and Accessibility access'
  )

  test('removes cancelled preedit without writing it to the PTY', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect(orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
      cangjieInputSourceId()
    )

    const ptyId = await waitForActivePanePtyId(orcaPage)
    // The line count MUST stay 1 — see the identical note in terminal-macos-pinyin-native.spec.ts.
    // The cancelled preedit emits nothing, so "nothing leaked" is enforced at the PTY by the single
    // captured line being exactly `ordinary\n`: a leaked key carries no newline and would prepend to
    // it. Raising this count silently turns that into a check that only the control worked.
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, ptyId, reader)
      await focusActiveTerminalInput(orcaPage)
      await installTerminalImeBoundaryProbe(orcaPage)
      typeKeyCodes(electronApp.process().pid!, [1])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe('尸')

      typeKeyCodes(electronApp.process().pid!, [51])
      await expect.poll(() => readActiveComposition(orcaPage)).toBe(null)
      const cancelTrace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(cancelTrace.dom.slice(0, RECORDED_CANGJIE_CANCEL_BOUNDARIES.length)).toMatchObject(
        RECORDED_CANGJIE_CANCEL_BOUNDARIES
      )

      selectInputSource(ABC_ID)
      await expect
        .poll(() => orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId()))
        .toBe(ABC_ID)
      await orcaPage.keyboard.type('ordinary')
      await orcaPage.keyboard.press('Enter')

      const completeTrace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(completeTrace.onData.slice(cancelTrace.onData.length).join('')).toBe('ordinary\r')
      expect(cancelTrace.onData).toEqual([])
      expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
        Buffer.from('ordinary\n').toString('hex')
      ])
      expect(completeTrace.onData.join('')).toBe('ordinary\r')
      completed = true
    } finally {
      await attachTerminalImeBoundaryEvidence(orcaPage, testInfo, 'native-macos-cangjie').catch(
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
