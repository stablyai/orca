// Hand-run: needs a real macOS input source, so no workflow calls it. A red run here is a
// local environment or an IME behaviour change, not necessarily a regression.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  ABC_ID,
  bounceFocus,
  enableInputSource,
  KEY,
  KOTOERI_ROMAJI_ID,
  KOTOERI_ROMAJI_PARENT_ID,
  pressChordAsTyped,
  selectInputSource,
  SIMPLIFIED_PINYIN_ID,
  SIMPLIFIED_PINYIN_PARENT_ID,
  TRADITIONAL_ZHUYIN_ID,
  TRADITIONAL_ZHUYIN_PARENT_ID,
  TWO_SET_KOREAN_ID,
  typeKeyCodes
} from './macos-input-source-driver'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes,
  type TerminalImeByteReader
} from './terminal-ime-byte-reader'

/**
 * #12871 — cursor chords during a live IME composition, asserted at the PTY, with the real OS
 * input methods deciding everything. The unit layer replays recorded traces; this spec is the
 * layer those traces came from, so a platform change (macOS redispatch timing, Kotoeri chord
 * swallowing) fails here first.
 *
 * What the recorded evidence established (in-app traces of 2026-08-08 at commit d64ccc71b, and
 * the independent bare-page recording on #12732):
 *   - 2-Set Korean commits the composing syllable ON the chord; the PTY must see the syllable
 *     strictly before the movement byte, exactly once each. This held on main and must survive
 *     the #12732 exemption+ledger (whose failure mode is the byte twice).
 *   - Kotoeri swallows the chord: the preedit must survive the press. On main the chord byte
 *     then never reached the shell at all (the defect half of #12871); with #12732's exemption
 *     the byte queues behind the preedit and lands right after the commit. The Kotoeri byte
 *     expectation below therefore REQUIRES the fix — on a pre-fix build this test fails on the
 *     missing \x01, which is exactly the regression it exists to catch.
 *   - Chinese (Zhuyin and Pinyin, measured 2026-08-09) behaves like Kotoeri and not like Korean:
 *     both swallow the chord, keep the preedit, and drain the byte at the commit. A Cmd chord
 *     there has no arrow keyup at all, so those two cells rest entirely on the Command release.
 *   - ABC control: no IME anywhere, movement bytes flow alone.
 *
 * Run-validity guards follow terminal-macos-korean-chord-commit-native.spec.ts: the selected
 * input source is read back, and a composition must actually form before any target key is
 * pressed, so a run where the IME never engaged is void rather than green.
 */

function readActiveComposition(page: Page): Promise<string | null> {
  // The macOS preedit lives in xterm's `.composition-view`, not in the helper textarea value;
  // null distinguishes an absent composition from an empty one.
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('\u200e', '') ?? null
  })
}

function readInputSourceId(page: Page): Promise<string> {
  return page.evaluate(() => window.api.app.getKeyboardInputSourceId())
}

/**
 * Run-validity warmup: compose 가, confirm real Hangul preedit, then erase it jamo-by-jamo so
 * nothing commits. Kills the first-keystroke engagement race the plain 2set spec flakes on.
 *
 * Measured on this rig: when the app launches while another layout is still selected, the
 * freshly focused input context can miss the switch entirely and the first keystrokes type
 * literal r/k. Erase whatever landed (preedit jamo or literal characters — backspace edits
 * either buffer without reaching the recorded line), bounce focus so the context re-reads the
 * source, and prove engagement again — the same dance the Kotoeri path always needed.
 */
async function warmUpKoreanComposition(page: Page, processId: number): Promise<void> {
  typeKeyCodes(processId, [15, 40])
  try {
    await expect.poll(() => readActiveComposition(page), { timeout: 6_000 }).toMatch(/[가-힣ㄱ-ㅣ]/)
  } catch {
    typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
    bounceFocus(processId)
    await focusActiveTerminalInput(page)
    typeKeyCodes(processId, [15, 40])
    await expect
      .poll(() => readActiveComposition(page), { timeout: 10_000 })
      .toMatch(/[가-힣ㄱ-ㅣ]/)
  }
  typeKeyCodes(processId, [KEY.backspace, KEY.backspace])
  await expect.poll(() => readActiveComposition(page), { timeout: 10_000 }).toBeNull()
}

/** Press Return to flush the pending line into the byte reader; a live preedit eats the first. */
async function flushLineToReader(
  page: Page,
  processId: number,
  reader: TerminalImeByteReader
): Promise<string[]> {
  pressChordAsTyped(processId, KEY.returnKey)
  try {
    return await waitForTerminalImeBytes(page, reader, 5_000)
  } catch {
    pressChordAsTyped(processId, KEY.returnKey)
    return waitForTerminalImeBytes(page, reader, 10_000)
  }
}

type SetupResult = {
  ptyId: string
  reader: TerminalImeByteReader
}

async function setUpTerminalWithReader(
  page: Page,
  testRepoPath: string,
  processId: number,
  warmUpKorean: boolean
): Promise<SetupResult> {
  await waitForActiveWorktree(page)
  await waitForSessionReady(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const ptyId = await waitForActivePanePtyId(page)
  await focusActiveTerminalInput(page)
  if (warmUpKorean) {
    selectInputSource(TWO_SET_KOREAN_ID)
    // The app is already focused, so its input context needs the bounce to adopt the switch —
    // without it the first run of a session composes nothing (the machine sat on another
    // layout) while later runs pass because afterEach left Korean selected before launch.
    bounceFocus(processId)
    await focusActiveTerminalInput(page)
    await expect.poll(() => readInputSourceId(page), { timeout: 10_000 }).toBe(TWO_SET_KOREAN_ID)
    await warmUpKoreanComposition(page, processId)
  }
  const reader = createTerminalImeByteReader(testRepoPath, 1)
  await startTerminalImeByteReader(page, ptyId, reader)
  await focusActiveTerminalInput(page)
  return { ptyId, reader }
}

test.describe('Native macOS IME cursor chords during composition @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with native IME access and Accessibility permission'
  )

  test.afterEach(() => {
    // Leave the machine on Korean 2-Set no matter which source a scenario selected.
    selectInputSource(TWO_SET_KOREAN_ID)
  })

  // The tty converts the trailing CR to LF, so a line arriving with \n is the standing proof
  // the capture reached past the renderer (#11936/#11951).
  for (const chord of [
    { name: 'Cmd+Left', modifier: 'command' as const, pty: '하\x01\n' },
    { name: 'Option+Left', modifier: 'option' as const, pty: '하\x1bb\n' }
  ]) {
    test(`Korean 2-Set: ${chord.name} mid-syllable commits 하 before the movement byte`, async ({
      electronApp,
      orcaPage,
      testRepoPath
    }) => {
      const processId = electronApp.process().pid
      if (processId === undefined) {
        throw new Error('Electron process id unavailable')
      }
      const setup = await setUpTerminalWithReader(orcaPage, testRepoPath, processId, true)
      try {
        // ㅎ(5) + ㅏ(40) → 하, still composing. The poll doubles as the positive control.
        typeKeyCodes(processId, [5, 40])
        await expect.poll(() => readActiveComposition(orcaPage), { timeout: 10_000 }).toBe('하')

        pressChordAsTyped(processId, KEY.left, chord.modifier)
        // Recorded: 2-Set Korean answers the chord with compositionend — the preedit must be
        // gone before any flush. A surviving preedit here would eat the Return below and turn
        // the byte assertion into a different scenario's evidence.
        await expect.poll(() => readActiveComposition(orcaPage), { timeout: 10_000 }).toBeNull()

        // Exactly the recorded line: the syllable strictly before its movement byte, one of
        // each. The double-fire failure mode (#12732's naive exemption) would append a second
        // movement byte; a reordering regression would put it before 하.
        expect(await flushLineToReader(orcaPage, processId, setup.reader)).toEqual([
          Buffer.from(chord.pty).toString('hex')
        ])
        expect(await getTerminalContent(orcaPage, 100_000)).toContain('하')
      } finally {
        removeTerminalImeByteReader(setup.reader)
      }
    })
  }

  test('Kotoeri Romaji: Cmd+Left leaves the さ preedit live; its byte lands after the commit', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const processId = electronApp.process().pid
    if (processId === undefined) {
      throw new Error('Electron process id unavailable')
    }
    // Korean warmup first proves the rig composes at all before the source switch.
    const setup = await setUpTerminalWithReader(orcaPage, testRepoPath, processId, true)
    try {
      enableInputSource(KOTOERI_ROMAJI_PARENT_ID)
      enableInputSource(KOTOERI_ROMAJI_ID)
      selectInputSource(KOTOERI_ROMAJI_ID)
      bounceFocus(processId)
      await focusActiveTerminalInput(orcaPage)
      // Selecting the RomajiTyping mode succeeds, but TIS reports the current source under the
      // legacy mode id 'com.apple.inputmethod.Japanese'.
      await expect
        .poll(() => readInputSourceId(orcaPage), { timeout: 10_000 })
        .toMatch(/^com\.apple\.inputmethod\.(Kotoeri\.RomajiTyping\.)?Japanese$/)

      // s(1) + a(0) → さ in the preedit. Bounce timing can swallow the first key; one retry.
      typeKeyCodes(processId, [1, 0])
      try {
        await expect
          .poll(() => readActiveComposition(orcaPage), { timeout: 6_000 })
          .toMatch(/[ぁ-ん]/)
      } catch {
        bounceFocus(processId)
        await focusActiveTerminalInput(orcaPage)
        typeKeyCodes(processId, [1, 0])
        await expect
          .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
          .toMatch(/[ぁ-ん]/)
      }

      pressChordAsTyped(processId, KEY.left, 'command')
      // Recorded: Kotoeri swallows the chord — no commit, no composition event. The preedit
      // surviving the press is the half of #12871 that held on main and must keep holding.
      // Read once rather than polled: the wait above is the settle, so the preedit is either
      // still there now or the chord committed it. Polling would let a late one pass.
      await orcaPage.waitForTimeout(700)
      expect(await readActiveComposition(orcaPage)).toMatch(/[ぁ-ん]/)

      // The Return commits さ and macOS redispatches it unmarked, which also flushes the line.
      // Byte order pins the #12732 exemption end to end: the chord's \x01 was queued behind
      // the preedit and must drain right after the commit — never before it, and exactly once.
      // On a pre-fix build this line arrives as さ\n (the byte silently dropped), which is the
      // #12871 defect this spec exists to keep fixed.
      expect(await flushLineToReader(orcaPage, processId, setup.reader)).toEqual([
        Buffer.from('さ\x01\n').toString('hex')
      ])
      expect(await getTerminalContent(orcaPage, 100_000)).toContain('さ')
    } finally {
      removeTerminalImeByteReader(setup.reader)
      selectInputSource(TWO_SET_KOREAN_ID)
    }
  })

  /**
   * Chinese, both scripts, both chords. Measured on this build 2026-08-09, driven with the
   * modifier as its own key event — every earlier Chinese capture folded it into the arrow's
   * flags, which produces no modifier press or release at all, and so could not see the Command
   * release that ends the gesture. The unit-layer half of the same recordings is in
   * src/renderer/src/components/terminal-pane/keyboard-handlers.issue-12871-chinese-chord-traces.ts.
   *
   * The four cells do not behave alike, and the table below records the differences rather than
   * smoothing them:
   *   - `Cmd+←` on both sources delivers NO arrow keyup, at any listener position or at
   *     Chromium's own input dispatch. The Command release is the gesture's only end and arrives
   *     still marked composing. Both those cells pass only because that release is honoured;
   *     before it the byte was dropped and the line arrived without it.
   *   - `Option+←` delivers the arrow's own keyup and resolves through it, as it always did.
   *     Pinned so the half that already worked fails loudly if it stops.
   *   - Pinyin keeps composing through either chord, and so does Zhuyin through `Cmd+←`.
   *     `composesThroughChord` is that measurement, and it doubles as those cells' positive
   *     control. It is deliberately absent from the Zhuyin `Option+←` cell: synthesized chords
   *     make that source commit on the press at every timing this rig can produce, while a human
   *     at the same keyboard keeps the preedit. Since the two disagree, the intermediate state is
   *     not asserted there — only the byte contract below, which holds either way.
   * In every cell the movement byte lands strictly after the committed text, exactly once.
   */
  for (const cell of [
    {
      script: 'Traditional Zhuyin',
      id: TRADITIONAL_ZHUYIN_ID,
      parentId: TRADITIONAL_ZHUYIN_PARENT_ID,
      sourceIdPattern: /^com\.apple\.inputmethod\.TCIM(\.|$)/,
      // Dachen layout: s=ㄋ u=ㄧ 3=ˇ then c=ㄏ l=ㄠ 3=ˇ. Zhuyin resolves bopomofo to hanzi inside
      // the preedit, so the composition view already reads two characters before the chord.
      keyCodes: [1, 32, 20, 8, 37, 20],
      preedit: /[ㄅ-ㄩˇˊˋ˙一-鿿]/,
      chord: 'Cmd+Left',
      modifier: 'command' as const,
      composesThroughChord: true,
      commitReturns: 0,
      // WHICH two hanzi is not this test's business and must not be: Zhuyin's candidate order
      // adapts to use, and a run that committed 妳好 rather than 你好 pinned the byte just as
      // well. The shape is the contract — the committed reading, then one movement byte, then
      // the line end, with nothing before the reading and nothing after the byte.
      byte: '\x01',
      commit: /^[一-鿿]{2}$/
    },
    {
      script: 'Traditional Zhuyin',
      id: TRADITIONAL_ZHUYIN_ID,
      parentId: TRADITIONAL_ZHUYIN_PARENT_ID,
      sourceIdPattern: /^com\.apple\.inputmethod\.TCIM(\.|$)/,
      keyCodes: [1, 32, 20, 8, 37, 20],
      preedit: /[ㄅ-ㄩˇˊˋ˙一-鿿]/,
      chord: 'Option+Left',
      modifier: 'option' as const,
      // No intermediate assertion here, on purpose. Driven by this rig the composition ends on
      // the press; driven by a hand it survives and commits on the Return. Both routes put the
      // same line on the pty, so the byte order below is asserted and the disputed state is not.
      composesThroughChord: undefined,
      commitReturns: 0,
      byte: '\x1bb',
      commit: /^[一-鿿]{2}$/
    },
    {
      script: 'Simplified Pinyin',
      id: SIMPLIFIED_PINYIN_ID,
      parentId: SIMPLIFIED_PINYIN_PARENT_ID,
      sourceIdPattern: /^com\.apple\.inputmethod\.SCIM(\.|$)/,
      // nihao. The preedit reads back segmented as `ni hao`, and Return commits those LETTERS
      // rather than the highlighted candidate (Space would take that), so the line is ASCII —
      // which is why the composition view, not the committed text, is this cell's proof that an
      // IME was engaged at all.
      keyCodes: [45, 34, 4, 0, 31],
      preedit: /^ni ?hao$/,
      chord: 'Cmd+Left',
      modifier: 'command' as const,
      composesThroughChord: true,
      commitReturns: 0,
      byte: '\x01',
      commit: /^nihao$/
    },
    {
      script: 'Simplified Pinyin',
      id: SIMPLIFIED_PINYIN_ID,
      parentId: SIMPLIFIED_PINYIN_PARENT_ID,
      sourceIdPattern: /^com\.apple\.inputmethod\.SCIM(\.|$)/,
      keyCodes: [45, 34, 4, 0, 31],
      preedit: /^ni ?hao$/,
      chord: 'Option+Left',
      modifier: 'option' as const,
      composesThroughChord: true,
      // This chord moves the caret between the preedit's segments, and the segmented preedit
      // then costs one Return more than the Cmd cell: the first merges the segments, the next
      // ends the composition. Spend that one here so flushLineToReader's own two presses mean
      // the same thing in this cell as everywhere else in this file.
      commitReturns: 1,
      byte: '\x1bb',
      commit: /^nihao$/
    }
  ]) {
    test(`${cell.script}: ${cell.chord} during composition puts its byte after the commit`, async ({
      electronApp,
      orcaPage,
      testRepoPath
    }) => {
      const processId = electronApp.process().pid
      if (processId === undefined) {
        throw new Error('Electron process id unavailable')
      }
      // Korean warmup first proves the rig composes at all before the source switch.
      const setup = await setUpTerminalWithReader(orcaPage, testRepoPath, processId, true)
      try {
        enableInputSource(cell.parentId)
        enableInputSource(cell.id)
        selectInputSource(cell.id)
        bounceFocus(processId)
        await focusActiveTerminalInput(orcaPage)
        // Chinese modes report back under the parent bundle id, the way Kotoeri reports under
        // the legacy Japanese one.
        await expect
          .poll(() => readInputSourceId(orcaPage), { timeout: 10_000 })
          .toMatch(cell.sourceIdPattern)

        // Bounce timing can swallow the first keystrokes; one retry, as for Kotoeri.
        typeKeyCodes(processId, cell.keyCodes)
        try {
          await expect
            .poll(() => readActiveComposition(orcaPage), { timeout: 6_000 })
            .toMatch(cell.preedit)
        } catch {
          bounceFocus(processId)
          await focusActiveTerminalInput(orcaPage)
          typeKeyCodes(processId, cell.keyCodes)
          await expect
            .poll(() => readActiveComposition(orcaPage), { timeout: 10_000 })
            .toMatch(cell.preedit)
        }

        pressChordAsTyped(processId, KEY.left, cell.modifier)
        // The positive control, where the two drivers agree on it: a source that committed here
        // would make the byte assertion below evidence about some other gesture. The one cell
        // where synthesis and hardware disagree opts out rather than pinning the rig's answer.
        // Read once rather than polled, as in the Kotoeri test: the wait above is the settle, so
        // the preedit is either still there now or the chord committed it. Polling would let a
        // late one pass.
        await orcaPage.waitForTimeout(700)
        if (cell.composesThroughChord === true) {
          expect(await readActiveComposition(orcaPage)).toMatch(cell.preedit)
        }

        for (let index = 0; index < cell.commitReturns; index += 1) {
          pressChordAsTyped(processId, KEY.returnKey)
          await orcaPage.waitForTimeout(400)
        }

        // The commit drains the queued chord byte, then the line ends. Anchored end to end, so a
        // byte ahead of the committed text (never queued) and a second copy of it (both releases
        // fired) each fail here rather than passing as a substring.
        const lines = await flushLineToReader(orcaPage, processId, setup.reader)
        expect(lines).toHaveLength(1)
        const line = Buffer.from(lines[0] ?? '', 'hex').toString('utf8')
        expect(line.endsWith(`${cell.byte}\n`)).toBe(true)
        const committed = line.slice(0, -(cell.byte.length + 1))
        expect(committed).toMatch(cell.commit)
        // The same committed text has to be on screen, not merely in the byte stream.
        expect(await getTerminalContent(orcaPage, 100_000)).toContain(committed)
      } finally {
        removeTerminalImeByteReader(setup.reader)
        selectInputSource(TWO_SET_KOREAN_ID)
      }
    })
  }

  test('ABC control: the same chords with no IME flow alone', async ({
    electronApp,
    orcaPage,
    testRepoPath
  }) => {
    const processId = electronApp.process().pid
    if (processId === undefined) {
      throw new Error('Electron process id unavailable')
    }
    const setup = await setUpTerminalWithReader(orcaPage, testRepoPath, processId, false)
    try {
      selectInputSource(ABC_ID)
      bounceFocus(processId)
      await focusActiveTerminalInput(orcaPage)
      await expect.poll(() => readInputSourceId(orcaPage), { timeout: 10_000 }).toBe(ABC_ID)

      typeKeyCodes(processId, [0, 11, 8]) // a b c
      await expect
        .poll(() => getTerminalContent(orcaPage, 100_000), { timeout: 10_000 })
        .toContain('abc')

      pressChordAsTyped(processId, KEY.left, 'command')
      pressChordAsTyped(processId, KEY.left, 'option')

      // The genuine non-IME control per the composition rulebook: with no composition anywhere
      // the movement bytes flow immediately and alone, in press order.
      expect(await flushLineToReader(orcaPage, processId, setup.reader)).toEqual([
        Buffer.from('abc\x01\x1bb\n').toString('hex')
      ])
    } finally {
      removeTerminalImeByteReader(setup.reader)
      selectInputSource(TWO_SET_KOREAN_ID)
    }
  })
})
