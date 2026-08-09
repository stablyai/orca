import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'

/**
 * #8038 / #10343 — c6 capture vehicle, not a regression test. Their c3 already lives at
 * terminal-stock-composition.test.ts:194/:208 and fails under pristine xterm.
 *
 * WHY THIS IS NOT A PORT of korean-ime-terminal-shift-enter-commit.spec.ts: that spec synthesizes
 * the composition it then asserts on — `Input.imeSetComposition` sets the preedit directly and
 * `Input.insertText` performs the commit directly. Asserting that the IME produced events you
 * yourself produced is circular, which is the ground #10896's adjudication was rejected on. Here
 * the OS IME owns the preedit, the commit instant, and `isComposing`; we only send key codes.
 *
 * SCOPE — 2 of that spec's 4 cases, deliberately. Its matrix is 2 chords x 2 orderings, and the
 * orderings are the two PLATFORM behaviours documented at
 * src/renderer/src/lib/ime-composition-keyboard-event.ts:52-59: Windows/Linux redispatch the
 * unmarked Enter/13 BEFORE keyup, macOS delivers keyup first and redispatches after. Only the
 * macOS ordering can occur here and it cannot be selected — the OS decides it. The Windows/Linux
 * ordering belongs on those hosts; a spec covering both would be synthesizing again.
 */

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
const SELECT_INPUT_SOURCE = path.resolve(__dirname, 'select-input-source.swift')

// 2-Set Korean: ㅎ = key code 5, ㅏ = key code 40, Space = 49. Three `하` separated by spaces,
// matching the byte expectations preserved below.
const HA_HA_HA_KEY_CODES = [5, 40, 49, 5, 40, 49, 5, 40] as const
const RETURN_KEY_CODE = 36

function selectTwoSetKorean(): void {
  execFileSync('swift', [SELECT_INPUT_SOURCE, TWO_SET_KOREAN_ID])
}

function focusApp(processId: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'delay 0.3'
  ])
}

function typeNativeKeyCodes(processId: number, keyCodes: readonly number[]): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to key code {${keyCodes.join(', ')}}`
  ])
}

/** The chord itself, pressed by the OS so the IME decides how to resolve it. */
function pressReturnChord(processId: number, modifier: 'shift' | 'control'): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to key code ${RETURN_KEY_CODE} using ${modifier} down`
  ])
}

function readActiveComposition(
  page: Parameters<typeof focusActiveTerminalInput>[0]
): Promise<string | null> {
  // Why: the macOS preedit lives in xterm's `.composition-view`, NOT in the helper textarea's
  // `.value` — CompositionHelper sets `_compositionView.textContent` and adds `.active`
  // (@xterm/xterm CompositionHelper.ts:73-74). Reading `.value` returns '' during composition, so
  // a control built on it can never pass. Returns null when the element is absent so an absent
  // composition is distinguishable from an empty one.
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

test.describe('Native macOS 2-Set Korean terminal chord commit @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with 2-Set Korean available and Accessibility access'
  )

  // `pty` is what the child reads. The trailing LF is the standing proof the capture got past the
  // renderer: onData emits CR and only the tty converts it, so a reader "correcting" a constant
  // back to the renderer form would show CR here (#11936/#11951).
  //
  // `flushesOwnLine` says whether the chord's own bytes end the line. The reader splits on 0x0a,
  // so CSI-u — carrying no line terminator — needs a plain Return after it, or the line stays open
  // and the capture times out at zero however correct the product was.
  for (const chord of [
    {
      name: 'Shift+Enter',
      modifier: 'shift' as const,
      flushesOwnLine: true,
      pty: '하 하 하\u001b\n'
    },
    {
      name: 'Ctrl+Enter',
      modifier: 'control' as const,
      flushesOwnLine: false,
      pty: '하 하 하\u001b[13;5u\n'
    }
  ]) {
    test(`commits the preedit before physical ${chord.name}`, async ({
      electronApp,
      orcaPage,
      testRepoPath
    }) => {
      const processId = electronApp.process().pid
      if (processId === undefined) {
        throw new Error('Electron process id unavailable')
      }

      await waitForActiveWorktree(orcaPage)
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await waitForActiveTerminalManager(orcaPage)
      const ptyId = await waitForActivePanePtyId(orcaPage)
      await focusActiveTerminalInput(orcaPage)

      // Select the real input source and READ IT BACK. An assumed selection is how a run becomes
      // a Latin-keystroke capture wearing a Korean label.
      selectTwoSetKorean()
      await expect
        .poll(() => orcaPage.evaluate(() => window.api.app.getKeyboardInputSourceId()), {
          timeout: 10_000
        })
        .toBe(TWO_SET_KOREAN_ID)

      // POSITIVE CONTROL, inside the run and before the target key: the OS IME must actually
      // compose. No Hangul in the preedit means the injection never reached the IME and the run
      // is VOID — not a failure of the product.
      typeNativeKeyCodes(processId, [5, 40])
      await expect
        .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
        .toMatch(/[가-힣㄰-㆏]/)

      const reader = createTerminalImeByteReader(testRepoPath, 1)
      try {
        await startTerminalImeByteReader(orcaPage, ptyId, reader)

        // Finish `하 하 하`: the control already left `하` composing, so send the remainder.
        typeNativeKeyCodes(processId, HA_HA_HA_KEY_CODES.slice(2))
        pressReturnChord(processId, chord.modifier)
        if (!chord.flushesOwnLine) {
          // Safe to send unmodified: the chord above already committed the preedit, which the
          // assertion's leading `하 하 하` proves — a surviving preedit would eat this Return and
          // put its own commit ahead of the chord's bytes.
          typeNativeKeyCodes(processId, [RETURN_KEY_CODE])
        }

        // The sibling spec's :364/:383 assert at the RENDERER (onData), where the terminator is CR.
        // This reads the PTY child, so the tty has already converted CR to LF — see #11936/#11951,
        // where that conversion is the standing proof a capture reached past the renderer.
        expect(await waitForTerminalImeBytes(orcaPage, reader)).toEqual([
          Buffer.from(chord.pty).toString('hex')
        ])
      } finally {
        removeTerminalImeByteReader(reader)
      }
    })
  }
})
