// Assert real preedit geometry: PTY byte checks passed while hidden overlays left users composing blind.
// CDP imeSetComposition opens Chromium composition without native IME/accessibility grants, enabling normal headless CI coverage.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import {
  commitImeText,
  composeHangulSyllable,
  dispatchPlainEnter,
  dispatchResumedCompositionUpdate,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import {
  expectPreeditHidden,
  expectPreeditRendered,
  samplePreeditOverlay
} from './terminal-ime-preedit-overlay-probe'
import { applyImePlatformPolicy } from './terminal-ime-platform-policy'
import {
  replayRecordedImeDomTrace,
  type RecordedImeDomTrace
} from './terminal-ime-recorded-dom-trace-replay'

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

const RECORDED_TRACE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'windows-wsl-2set-hangul-dom-trace.json'), 'utf8')
) as RecordedImeDomTrace

test.describe('Terminal 2-Set Korean preedit visibility', () => {
  test('shows every assembling jamo at non-zero size and commits the syllable ahead of the newline', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      await expectPreeditHidden(orcaPage, 'before composing')

      for (const frame of HAN_FRAMES) {
        await composeHangulSyllable(arena.session, orcaPage, [frame])
        await expectPreeditRendered(orcaPage, frame.preedit, `composing ${frame.preedit}`)
      }

      await commitImeText(arena.session, '한')
      await expectPreeditHidden(orcaPage, 'after committing 한')

      await dispatchPlainEnter(arena.session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('한\n').toString('hex')])

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      // The ordering the user reported as broken: the syllable must precede the newline.
      expect(trace.onData.join('')).toBe('한\r')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-preedit-visibility', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  test('keeps a preedit the IME resumes without a compositionstart visible', async ({
    orcaPage
  }, testInfo) => {
    // Bare compositionupdate writes preedit without xterm’s compositionstart-only .active, hiding text despite correct bytes.
    // Pre-existing on main; fixed in xterm’s CompositionHelper visibility layer.
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      // Synthesize this ordering; dispatchResumedCompositionUpdate explains why the recorded corpus cannot supply it.
      await dispatchResumedCompositionUpdate(orcaPage, '한')

      const sample = await samplePreeditOverlay(orcaPage)
      expect(sample.found, 'no composition overlay exists').toBe(true)
      expect(sample.text, 'the resumed preedit text never reached the overlay').toBe('한')
      expect(
        sample.rect.width,
        'the resumed preedit was written into an overlay with zero width — the user composes blind'
      ).toBeGreaterThan(0)
      expect(sample.rect.height, 'the resumed preedit overlay has zero height').toBeGreaterThan(0)
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-resumed-preedit', !completed)
    }
  })

  test('renders the preedit at every update of a recorded Windows/WSL Hangul session', async ({
    orcaPage
  }, testInfo) => {
    // Pin Windows renderer policy for the Windows recording regardless of runner OS.
    await applyImePlatformPolicy(orcaPage, 'windows')
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      const replay = await replayRecordedImeDomTrace(orcaPage, RECORDED_TRACE)
      const updates = replay.samples.filter(
        (sample) => sample.type === 'compositionupdate' && sample.data.length > 0
      )
      // Require updates so replacing the fixture with an empty sequence cannot pass.
      expect(updates.length, 'the recorded trace carries no composition updates').toBe(37)

      const invisible = updates.filter(
        (sample) => sample.overlay.rect.width === 0 || sample.overlay.rect.height === 0
      )
      expect(
        invisible.map((sample) => ({ index: sample.index, data: sample.data })),
        'these recorded preedit frames were written into an overlay with no size'
      ).toEqual([])

      const committed = replay.samples
        .filter((sample) => sample.type === 'compositionend' && sample.data.length > 0)
        .map((sample) => sample.data)
      expect(committed.join('')).toBe('문제모르겠네안녕하세요')

      // Assert captured PTY bytes to catch dropped syllables; trailing ASCII hello checks post-Korean plain input.
      expect(replay.onData).toBe((RECORDED_TRACE.onData ?? []).map((entry) => entry.data).join(''))
      expect(replay.onData).toBe('문제\r모르겠네\r안녕하세요\rhello\r')
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'korean-recorded-trace-preedit', !completed)
    }
  })

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
