// #12871: Cmd+Left overtook composing 다, turning 가나다 into 다가다.
// Units pin the synthetic handler; assert merged PTY ordering across composition-end and chord-transport routes.
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
    // Pin macOS policy so Cmd+Left emits Ctrl+A even on Linux; otherwise the missing chord byte makes this arm vacuous.
    await applyImePlatformPolicy(orcaPage, 'mac')
    await expectImePlatformPolicy(orcaPage, 'mac')

    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)

      await composeHangulSyllable(arena.session, orcaPage, DA_FRAMES)

      // Press during preedit; before the fix the chord overtook the earlier-typed 다.
      await arena.session.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        windowsVirtualKeyCode: 37,
        nativeVirtualKeyCode: 37,
        modifiers: 4
      })

      await commitImeText(arena.session, '다')
      // Let the held chord’s post-composition macrotask land before Enter terminates the reader line, preserving the measured pair.
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
