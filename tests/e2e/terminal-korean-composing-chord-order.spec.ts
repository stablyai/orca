/**
 * #12871: a cursor chord pressed while a syllable is still composing reached the pty ahead of the
 * text it was typed after. With `가나` on the line, typing `가나다` and pressing Cmd+Left left
 * `다가다` — the composing `다` landed at the cursor's destination.
 *
 * The unit coverage in `keyboard-handlers-ime-composing-chord.test.tsx` pins the handler's
 * ordering against a synthetic transport. This asserts the same ordering at the pty, where the
 * committed glyph and the chord arrive by two different routes — the composition session-end
 * handler and the transport — and only their merged order is observable.
 */
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import {
  commitImeText,
  composeHangulSyllable,
  dispatchPlainEnter,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { applyImePlatformPolicy, expectImePlatformPolicy } from './terminal-ime-platform-policy'

const JAMO: Record<string, ImeKeyIdentity> = {
  ㄷ: { key: 'ㄷ', code: 'KeyE', keyCode: 229 },
  ㅏ: { key: 'ㅏ', code: 'KeyK', keyCode: 229 }
}

/** ㄷ → ㅏ assembles 다, which stays composing because a final consonant could still follow. */
const DA_FRAMES = [
  { jamoKey: JAMO['ㄷ'], preedit: 'ㄷ' },
  { jamoKey: JAMO['ㅏ'], preedit: '다' }
] as const

/** Cmd+Left resolves to Ctrl+A (readline start-of-line) — the chord from the report. */
const CMD_LEFT_BYTE = '\x01'

test.describe('Terminal 2-Set Korean composing-chord order', () => {
  test('sends the composing syllable before a Cmd+Left pressed during it', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    // Cmd+Left resolves to \x01 only under the macOS branch of the shortcut policy, so a Linux
    // runner produces no chord byte at all and the spec would pass by measuring nothing. Pinning
    // the renderer's platform is what lets the reported chord run on any shard; the assertion
    // below fails loudly if the override did not take.
    await applyImePlatformPolicy(orcaPage, 'mac')
    await expectImePlatformPolicy(orcaPage, 'mac')

    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)

      await composeHangulSyllable(arena.session, orcaPage, DA_FRAMES)

      // Pressed while the syllable is still in preedit. Before the fix this reached the pty
      // immediately, ahead of the 다 that had been typed first.
      await arena.session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
        nativeVirtualKeyCode: 37,
        modifiers: 4
      })

      await commitImeText(arena.session, '다')
      // The held chord flushes a macrotask after the composition session ends. Enter is only here
      // to terminate the line for the reader, so let the chord land before adding it — otherwise
      // the newline overtakes it and the assertion measures the wrong pair.
      await orcaPage.waitForTimeout(250)
      await dispatchPlainEnter(arena.session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from(`다${CMD_LEFT_BYTE}\n`).toString('hex')])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-composing-chord-order', !completed)
      removeTerminalImeByteReader(reader)
    }
  })
})
