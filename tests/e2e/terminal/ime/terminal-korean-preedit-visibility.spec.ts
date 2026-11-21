// Assert real preedit geometry: PTY byte checks passed while hidden overlays left users composing blind.
// CDP imeSetComposition opens Chromium composition without native IME/accessibility grants, enabling normal headless CI coverage.

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import {
  commitImeText,
  composeHangulSyllable,
  dispatchPlainEnter,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import './terminal-ime-preedit-overlay-probe'

/** 2-Set Korean maps each jamo to a QWERTY position; the IME rewrites `key` to the jamo itself. */
const JAMO: Record<string, ImeKeyIdentity> = {
  ㅎ: { key: 'ㅎ', code: 'KeyG', keyCode: 71 },
  ㅏ: { key: 'ㅏ', code: 'KeyK', keyCode: 75 },
  ㄴ: { key: 'ㄴ', code: 'KeyS', keyCode: 83 },
  ㄱ: { key: 'ㄱ', code: 'KeyR', keyCode: 82 },
  ㅡ: { key: 'ㅡ', code: 'KeyM', keyCode: 77 },
  ㄹ: { key: 'ㄹ', code: 'KeyF', keyCode: 70 }
}

/** ㅎ → ㅏ → ㄴ assembles 한; the preedit shows the partially assembled syllable at each step. */
const HAN_FRAMES = [
  { jamoKey: JAMO['ㅎ'], preedit: 'ㅎ' },
  { jamoKey: JAMO['ㅏ'], preedit: '하' },
  { jamoKey: JAMO['ㄴ'], preedit: '한' }
] as const

/** ㄱ → ㅡ → ㄹ assembles 글. */
const GEUL_FRAMES = [
  { jamoKey: JAMO['ㄱ'], preedit: 'ㄱ' },
  { jamoKey: JAMO['ㅡ'], preedit: '그' },
  { jamoKey: JAMO['ㄹ'], preedit: '글' }
] as const

test.describe('Terminal 2-Set Korean preedit visibility', () => {
  test('loses and duplicates nothing when back-to-back syllables commit at full speed', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      // No frame/syllable settling: fast-typing cadence previously dropped or doubled boundary syllables.
      for (let repetition = 0; repetition < 4; repetition += 1) {
        await composeHangulSyllable(arena.session, orcaPage, HAN_FRAMES, 0)
        await commitImeText(arena.session, '한')
        await composeHangulSyllable(arena.session, orcaPage, GEUL_FRAMES, 0)
        await commitImeText(arena.session, '글')
      }
      await dispatchPlainEnter(arena.session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from(`${'한글'.repeat(4)}\n`).toString('hex')])

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(trace.onData.join('')).toBe(`${'한글'.repeat(4)}\r`)
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-fast-cadence', !completed)
      removeTerminalImeByteReader(reader)
    }
  })
})
