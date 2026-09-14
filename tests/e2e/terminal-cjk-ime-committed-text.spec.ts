/**
 * Headless end-to-end coverage for Japanese and Chinese terminal input.
 *
 * Three shapes are covered, and the second is the one the whole suite used to be blind to:
 *
 *  1. Phrase-level composition — a Japanese preedit that grows to several characters and converts
 *     to kanji, and a pinyin preedit that spends most of its life as multi-letter romanisation.
 *     Both are asserted on the overlay's real geometry rather than on the bytes they later emit.
 *  2. Committed text that arrives with **no composition session at all**. Full-width punctuation
 *     (`，` `。` `、`) and full-width digits are typed as a single keystroke that the input source
 *     rewrites; there is no compositionstart/update/end around them. Every IME test in the repo
 *     was composition-session-shaped, so this shape was invisible to the suite by construction —
 *     which is how `，` reaching the shell as an ASCII `,` shipped to users. This is the macOS
 *     shape, and the tests for it pin the macOS ownership policy.
 *  3. The same full-width punctuation arriving **inside** a composition session, which is how the
 *     Windows and Linux frameworks deliver it. Same user-facing guarantee, different ordering.
 *
 * The assertion for shapes 2 and 3 is deliberately "the ASCII byte never appears" rather than "the
 * substitution was applied": the correct design never manufactures the ASCII byte in the first
 * place, so pinning its absence stays true under a forwarder rewrite as well as under a
 * structural one.
 */
import type { CDPSession } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  commitImeText,
  dispatchImeProcessKey,
  dispatchImeRewrittenPrintableKey,
  dispatchImeSubstitutedTextKey,
  dispatchPlainEnter,
  setImeComposition,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { expectPreeditHidden, expectPreeditRendered } from './terminal-ime-preedit-overlay-probe'
import { applyImePlatformPolicy, type ImePlatformPolicy } from './terminal-ime-platform-policy'

/** Frames a Japanese IME shows while typing にほんご and converting it to 日本語. */
const JAPANESE_FRAMES = ['に', 'にほ', 'にほん', 'にほんご', '日本語'] as const

/**
 * Substitutions an East Asian input source commits from one keystroke, with no composition session
 * around them. `ascii` is the character the physical key carries in the Latin layout — the byte the
 * user must never see — and `glyph` is what the input source actually committed.
 */
type SubstitutedKeystroke = ImeKeyIdentity & { glyph: string; ascii: string }

const FULL_WIDTH_PUNCTUATION: readonly SubstitutedKeystroke[] = [
  { key: ',', code: 'Comma', keyCode: 188, glyph: '，', ascii: ',' },
  { key: '.', code: 'Period', keyCode: 190, glyph: '。', ascii: '.' },
  { key: ',', code: 'Comma', keyCode: 188, glyph: '、', ascii: ',' }
]

const FULL_WIDTH_DIGITS: readonly SubstitutedKeystroke[] = [
  { key: '1', code: 'Digit1', keyCode: 49, glyph: '１', ascii: '1' },
  { key: '2', code: 'Digit2', keyCode: 50, glyph: '２', ascii: '2' },
  { key: '3', code: 'Digit3', keyCode: 51, glyph: '３', ascii: '3' }
]

const SUBSTITUTION_GROUPS = [
  { label: 'punctuation', keystrokes: FULL_WIDTH_PUNCTUATION },
  { label: 'digits', keystrokes: FULL_WIDTH_DIGITS }
] as const

/**
 * The two ways a substituted keystroke can reach the renderer. Both are real; only the second one
 * regressed, and only the second one can regress, which is why running both is the point.
 */
const SUBSTITUTION_SHAPES: readonly {
  name: string
  slug: string
  dispatch: (session: CDPSession, keystroke: SubstitutedKeystroke) => Promise<void>
}[] = [
  {
    // Green, and honest about its limits: xterm's own key handler emits `event.key`, so this shape
    // survives with or without a forwarder and would have passed throughout the regression. It
    // guards the frameworks that do rewrite `key`; it is not the regression guard.
    name: 'the keydown already carries the substituted glyph',
    slug: 'rewritten-keydown',
    dispatch: (session, keystroke) =>
      dispatchImeRewrittenPrintableKey(session, {
        key: keystroke.glyph,
        code: keystroke.code,
        keyCode: keystroke.keyCode
      })
  },
  {
    // The regression guard. Red on `main`, green from the structural-forwarder layer down.
    //
    // The keydown carries the plain Latin `,` and the `，` exists only in the following `input`
    // event, so anything that produces bytes from the keydown emits the ASCII form and destroys
    // the real one. Today the bypass that would prevent that is gated on the OS reporting an
    // input source whose id matches a 23-term allowlist. That read returns null on every
    // non-macOS host and `com.apple.keylayout.*` on a macOS runner with no CJK source selected,
    // and the preload API surface is frozen so no spec can stub it — meaning correctness here is
    // not expressible as a test until the gate goes away.
    //
    // Closed by the structural rule one layer below: bytes for printable characters come only from
    // the `input` event, decided on the event's own shape with no input-source read. Verified on
    // real macOS hardware — with an Apple pinyin source selected, the pty receives ef bc 8c e3 80 82
    // (，。) where main sends ASCII. Note main can pass this by luck: an input source whose id
    // happens to contain an allowlist term, such as Sogou's, satisfies the old gate.
    name: 'the keydown still carries the ASCII layout key',
    slug: 'substituted-insert-text',
    dispatch: (session, keystroke) =>
      dispatchImeSubstitutedTextKey(session, keystroke, keystroke.glyph)
  }
]

/**
 * The two substitution shapes above are macOS-only, and deliberately so: the keydown bypass that
 * owns single-keystroke IME commits installs only when the renderer reports macOS, because only
 * the macOS text system delivers a substituted glyph with the plain layout key still on the
 * keydown. Windows and Linux frameworks claim the same keystroke as VK_PROCESSKEY and route the
 * glyph through a composition session instead, which the separate composition-session test below
 * covers. Running the macOS shapes under a Linux policy would assert a sequence no Linux input
 * framework produces.
 */
const FULL_WIDTH_SESSION_PUNCTUATION = [
  { key: ',', code: 'Comma', keyCode: 188, glyph: '，', ascii: ',' },
  { key: '.', code: 'Period', keyCode: 190, glyph: '。', ascii: '.' }
] as const

test.describe('Terminal CJK IME committed text', () => {
  test('shows a growing Japanese phrase preedit and commits the converted kanji', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      await expectPreeditHidden(orcaPage, 'before composing')
      await dispatchImeProcessKey(arena.session, { key: 'Process', code: 'KeyN' })

      const widthByFrame = new Map<string, number>()
      for (const frame of JAPANESE_FRAMES) {
        await setImeComposition(arena.session, frame)
        const sample = await expectPreeditRendered(orcaPage, frame, `composing ${frame}`)
        widthByFrame.set(frame, sample.rect.width)
      }
      // A phrase-level preedit must widen as it grows. An overlay pinned to one cell renders only
      // the first character, which is a shape every non-geometric assertion reports as correct.
      expect(widthByFrame.get('にほんご')!).toBeGreaterThan(widthByFrame.get('に')!)
      expect(widthByFrame.get('日本語')!).toBeGreaterThan(widthByFrame.get('に')!)

      await commitImeText(arena.session, '日本語')
      await expectPreeditHidden(orcaPage, 'after committing 日本語')
      await dispatchPlainEnter(arena.session)

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('日本語\n').toString('hex')])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'japanese-phrase-preedit', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  for (const shape of SUBSTITUTION_SHAPES) {
    for (const group of SUBSTITUTION_GROUPS) {
      test(`sends full-width ${group.label} and never their ASCII form when ${shape.name}`, async ({
        orcaPage,
        testRepoPath
      }, testInfo) => {
        await applyImePlatformPolicy(orcaPage, 'mac')
        const arena = await openTerminalImePaneArena(orcaPage)
        const reader = createTerminalImeByteReader(testRepoPath, 1)
        const expected = group.keystrokes.map((keystroke) => keystroke.glyph).join('')
        let completed = false
        try {
          await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
          for (const keystroke of group.keystrokes) {
            await shape.dispatch(arena.session, keystroke)
            await orcaPage.waitForTimeout(60)
          }
          await dispatchPlainEnter(arena.session)

          const sent = (await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')
          for (const keystroke of group.keystrokes) {
            expect(
              sent,
              `${keystroke.glyph} reached the PTY as ASCII ${keystroke.ascii}`
            ).not.toContain(keystroke.ascii)
          }
          expect(sent).toBe(`${expected}\r`)

          const received = await waitForTerminalImeBytes(orcaPage, reader)
          expect(received).toEqual([Buffer.from(`${expected}\n`).toString('hex')])
          completed = true
        } finally {
          await closeTerminalImePaneArena(
            arena,
            testInfo,
            `full-width-${group.label}-${shape.slug}`,
            !completed
          )
          removeTerminalImeByteReader(reader)
        }
      })
    }
  }

  test('forwards Chinese pinyin conversions and their trailing full-width stop together', async ({
    orcaPage,
    testRepoPath
  }, testInfo) => {
    await applyImePlatformPolicy(orcaPage, 'mac')
    const arena = await openTerminalImePaneArena(orcaPage)
    const reader = createTerminalImeByteReader(testRepoPath, 1)
    let completed = false
    try {
      await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
      await dispatchImeProcessKey(arena.session, { key: 'Process', code: 'KeyN' })
      const widthByFrame = new Map<string, number>()
      for (const frame of ['n', 'ni', 'niha', 'nihao', '你好']) {
        await setImeComposition(arena.session, frame)
        const sample = await expectPreeditRendered(orcaPage, frame, `composing ${frame}`)
        widthByFrame.set(frame, sample.rect.width)
      }
      // Pinyin spends most of its life as a multi-letter romanisation before any Chinese appears,
      // so an overlay pinned to a single cell shows the user only the first letter of what they
      // typed. Width is the only property that catches that; text content looks correct.
      expect(widthByFrame.get('nihao')!).toBeGreaterThan(widthByFrame.get('n')!)
      expect(widthByFrame.get('你好')!).toBeGreaterThan(widthByFrame.get('n')!)

      await commitImeText(arena.session, '你好')
      await expectPreeditHidden(orcaPage, 'after committing 你好')

      // The distinct risk here is the adjacency, not the substitution: the stop arrives with no
      // composition session immediately after one closed, so a tracker that still believes a
      // composition is open swallows it. Dispatched in the glyph-carrying shape so this stays a
      // test of the transition rather than a second copy of the known-broken case above.
      await dispatchImeRewrittenPrintableKey(arena.session, {
        key: '。',
        code: 'Period',
        keyCode: 190
      })
      await orcaPage.waitForTimeout(60)
      await dispatchPlainEnter(arena.session)

      const trace = await readTerminalImeBoundaryTrace(orcaPage)
      expect(trace.onData.join('')).toBe('你好。\r')

      const received = await waitForTerminalImeBytes(orcaPage, reader)
      expect(received).toEqual([Buffer.from('你好。\n').toString('hex')])
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'pinyin-with-full-width-stop', !completed)
      removeTerminalImeByteReader(reader)
    }
  })

  for (const policy of ['windows', 'linux'] as const satisfies readonly ImePlatformPolicy[]) {
    test(`sends full-width punctuation committed through a composition session on ${policy}`, async ({
      orcaPage,
      testRepoPath
    }, testInfo) => {
      // SYNTHESISED, and the reason is worth stating: the recorded corpus contains no Windows or
      // Linux capture of full-width punctuation, only of Hangul and pinyin. What is not synthesised
      // is the shape — on these platforms the framework claims the punctuation key as
      // VK_PROCESSKEY and routes the substituted glyph through a real composition arena.session, which is
      // what `Input.imeSetComposition` opens, rather than through the macOS insertText path the
      // tests above cover. The ASCII form is asserted absent rather than the substitution asserted
      // present, so this stays true of any design that never manufactures the ASCII byte.
      await applyImePlatformPolicy(orcaPage, policy)
      const arena = await openTerminalImePaneArena(orcaPage)
      const reader = createTerminalImeByteReader(testRepoPath, 1)
      const expected = FULL_WIDTH_SESSION_PUNCTUATION.map((entry) => entry.glyph).join('')
      let completed = false
      try {
        await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
        for (const entry of FULL_WIDTH_SESSION_PUNCTUATION) {
          await dispatchImeProcessKey(arena.session, { key: 'Process', code: entry.code })
          await setImeComposition(arena.session, entry.glyph)
          await expectPreeditRendered(orcaPage, entry.glyph, `composing ${entry.glyph}`)
          await commitImeText(arena.session, entry.glyph)
          await expectPreeditHidden(orcaPage, `after committing ${entry.glyph}`)
        }
        await dispatchPlainEnter(arena.session)

        const sent = (await readTerminalImeBoundaryTrace(orcaPage)).onData.join('')
        for (const entry of FULL_WIDTH_SESSION_PUNCTUATION) {
          expect(sent, `${entry.glyph} reached the PTY as ASCII ${entry.ascii}`).not.toContain(
            entry.ascii
          )
        }
        expect(sent).toBe(`${expected}\r`)

        const received = await waitForTerminalImeBytes(orcaPage, reader)
        expect(received).toEqual([Buffer.from(`${expected}\n`).toString('hex')])
        completed = true
      } finally {
        await closeTerminalImePaneArena(
          arena,
          testInfo,
          `full-width-punctuation-session-${policy}`,
          !completed
        )
        removeTerminalImeByteReader(reader)
      }
    })
  }
})
