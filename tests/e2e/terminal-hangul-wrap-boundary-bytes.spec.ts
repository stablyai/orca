/**
 * Byte-exactness for a Hangul run long enough to wrap.
 *
 * The gap this closes is real independent of any bug report: every CJK byte-exactness spec in the
 * suite types a handful of characters (`日本語`, `你好。`), so none of them ever reaches the right
 * edge of a row. A wide glyph that does not fit in the last cell has to move to the next row, and
 * that regime had no byte-level coverage at all.
 *
 * #15066 claims a long Hangul run gains a stray line feed and two spaces near the wrap point — 42
 * typed, 45 stored. Chasing that report is what produced this spec, and the report did not hold:
 * the stray spaces are real characters in the buffer, but the shell *wrote* them as output. They
 * appear only when the prompt carries non-printing escapes that are not wrapped in `\[ \]`, which
 * makes readline's wrap arithmetic pad at the boundary; with a plain prompt the identical run at
 * the identical width renders clean. Nothing extra ever reached the pty as input.
 *
 * DIRECTION MATTERS: the byte reader is a node process holding the pty, so what it records is what
 * the pty *received as input*, never what the shell echoed back. An extra byte observed here could
 * only have been manufactured by the renderer's input path — which is the half of this that is
 * Orca's to guarantee, and the half that had no coverage.
 */
import type { CDPSession, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import {
  commitImeText,
  composeHangulSyllable,
  dispatchImeProcessKey,
  dispatchImeRewrittenPrintableKey,
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
import {
  applyImePlatformPolicy,
  expectImePlatformPolicy,
  type ImePlatformPolicy
} from './terminal-ime-platform-policy'

type JamoKey = { jamo: string; code: string; index: number }

/** 2-Set Korean: the physical key each jamo sits on, plus its index in the Hangul syllable formula. */
const CHOSEONG: readonly JamoKey[] = [
  { jamo: 'ㄱ', code: 'KeyR', index: 0 },
  { jamo: 'ㄴ', code: 'KeyS', index: 2 },
  { jamo: 'ㄷ', code: 'KeyE', index: 3 },
  { jamo: 'ㄹ', code: 'KeyF', index: 5 },
  { jamo: 'ㅁ', code: 'KeyA', index: 6 },
  { jamo: 'ㅂ', code: 'KeyQ', index: 7 },
  { jamo: 'ㅅ', code: 'KeyT', index: 9 },
  { jamo: 'ㅇ', code: 'KeyD', index: 11 }
]

const JUNGSEONG: readonly JamoKey[] = [
  { jamo: 'ㅏ', code: 'KeyK', index: 0 },
  { jamo: 'ㅓ', code: 'KeyJ', index: 4 },
  { jamo: 'ㅗ', code: 'KeyH', index: 8 },
  { jamo: 'ㅜ', code: 'KeyN', index: 13 }
]

/** IME preedit keystrokes carry no text payload, so every jamo key is a VK_PROCESSKEY. */
function jamoIdentity(key: JamoKey): ImeKeyIdentity {
  return { key: key.jamo, code: key.code, keyCode: 229 }
}

/** A plain printable keydown, used to push the run one cell out of phase with the row. */
const OFFSET_KEY: ImeKeyIdentity = { key: 'x', code: 'KeyX', keyCode: 88 }

type HangulSyllable = {
  text: string
  frames: readonly { jamoKey: ImeKeyIdentity; preedit: string }[]
}

/** Every syllable is two keystrokes: consonant, then vowel, which assembles the precomposed glyph. */
function buildHangulRun(length: number): HangulSyllable[] {
  return Array.from({ length }, (_unused, position) => {
    const choseong = CHOSEONG[position % CHOSEONG.length]
    const jungseong = JUNGSEONG[Math.floor(position / CHOSEONG.length) % JUNGSEONG.length]
    const text = String.fromCharCode(0xac00 + (choseong.index * 21 + jungseong.index) * 28)
    return {
      text,
      frames: [
        { jamoKey: jamoIdentity(choseong), preedit: choseong.jamo },
        { jamoKey: jamoIdentity(jungseong), preedit: text }
      ]
    }
  })
}

type PaneGrid = { cols: number; cursorRow: number }

async function readPaneGrid(page: Page, ptyId: string): Promise<PaneGrid> {
  return page.evaluate((targetPtyId) => {
    for (const manager of window.__paneManagers?.values?.() ?? []) {
      const pane = manager
        .getPanes?.()
        .find((candidate) => candidate.container.dataset.ptyId === targetPtyId)
      if (pane) {
        const buffer = pane.terminal.buffer.active
        return { cols: pane.terminal.cols, cursorRow: buffer.baseY + buffer.cursorY }
      }
    }
    return { cols: 0, cursorRow: 0 }
  }, ptyId)
}

/**
 * Splits the pane down instead of calling `terminal.resize`.
 *
 * A direct `resize` does take, but the pane's fit pass re-fits to the container the moment
 * anything else touches layout, so the width silently springs back mid-run and the spec ends up
 * measuring the wide default. Splitting narrows the container itself, which is the only width the
 * fit pass will agree to keep.
 */
async function narrowPaneBySplitting(page: Page, splits: number): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  for (let split = 0; split < splits; split += 1) {
    await splitActiveTerminalPane(page, 'vertical')
    await waitForPaneCount(page, split + 2)
  }
}

async function waitForSettledCols(page: Page, ptyId: string): Promise<number> {
  let settled = 0
  await expect
    .poll(
      async () => {
        const observed = (await readPaneGrid(page, ptyId)).cols
        const stable = observed === settled && observed > 0
        settled = observed
        return stable
      },
      { timeout: 10_000, message: 'terminal width never settled' }
    )
    .toBe(true)
  return settled
}

/** `pauseMs` is the gap between keystrokes; each syllable commits before the next one starts. */
async function typeHangulRun(
  session: CDPSession,
  page: Page,
  run: readonly HangulSyllable[],
  pauseMs: number
): Promise<void> {
  for (const syllable of run) {
    await composeHangulSyllable(session, page, syllable.frames, pauseMs)
    await commitImeText(session, syllable.text)
  }
}

/** One composition session whose preedit grows one syllable at a time, then commits whole. */
async function composeThenCommitPhrase(
  session: CDPSession,
  page: Page,
  run: readonly HangulSyllable[],
  pauseMs: number
): Promise<void> {
  let preedit = ''
  for (const syllable of run) {
    preedit += syllable.text
    await dispatchImeProcessKey(session, syllable.frames[0].jamoKey)
    await setImeComposition(session, preedit)
    if (pauseMs > 0) {
      await page.waitForTimeout(pauseMs)
    }
  }
  await commitImeText(session, preedit)
}

const KEYSTROKE_PAUSE_MS = 16

/**
 * Asserts the pty received exactly `expectedText` and nothing else.
 *
 * Both forms are checked on purpose: the decoded compare is what makes a failure readable (an
 * inserted LF or space shows up in the diff), the hex compare is what makes it byte-exact.
 */
function expectExactPtyInput(received: readonly string[], expectedText: string): void {
  const decoded = received.map((hex) => Buffer.from(hex, 'hex').toString('utf8'))
  expect(decoded).toEqual([`${expectedText}\n`])
  expect(received).toEqual([Buffer.from(`${expectedText}\n`).toString('hex')])
}

type WrapScenario = {
  name: string
  /** Shifts the run one cell out of phase, so the boundary falls mid-syllable at even widths. */
  offsetByOneCell: boolean
  /** Derived from the width the pane actually has, never from an assumed 80. */
  syllableCount: (observedCols: number) => number
  drive: (session: CDPSession, page: Page, run: readonly HangulSyllable[]) => Promise<void>
  policies: readonly ImePlatformPolicy[]
}

const SCENARIOS: readonly WrapScenario[] = [
  {
    // The count from the report, starting at column 0.
    name: '42 syllables',
    offsetByOneCell: false,
    syllableCount: () => 42,
    drive: (session, page, run) => typeHangulRun(session, page, run, KEYSTROKE_PAUSE_MS),
    policies: ['mac', 'windows', 'linux']
  },
  {
    // Same run one cell out of phase. Whichever parity the pane's real width has, this and the
    // scenario above cover both the clean boundary and the one where the next syllable is too wide
    // for the last cell and has to move down a row.
    name: '42 syllables offset by one cell',
    offsetByOneCell: true,
    syllableCount: () => 42,
    drive: (session, page, run) => typeHangulRun(session, page, run, KEYSTROKE_PAUSE_MS),
    policies: ['mac']
  },
  {
    // Ends on the last syllable that fits the row, leaving the emulator in its deferred-wrap state
    // when Enter arrives.
    name: 'a run that ends on the wrap boundary',
    offsetByOneCell: false,
    syllableCount: (observedCols) => Math.floor(observedCols / 2) * 2,
    drive: (session, page, run) => typeHangulRun(session, page, run, KEYSTROKE_PAUSE_MS),
    policies: ['mac']
  },
  {
    // Composes across the boundary instead of committing before it: the preedit outgrows the rest
    // of the row and only commits once it is well past the edge.
    name: 'a composition that straddles the wrap boundary',
    offsetByOneCell: false,
    syllableCount: (observedCols) => Math.floor(observedCols / 2) + 8,
    drive: (session, page, run) => composeThenCommitPhrase(session, page, run, KEYSTROKE_PAUSE_MS),
    policies: ['mac']
  }
]

test.describe('Terminal Hangul wrap-boundary byte exactness', () => {
  for (const scenario of SCENARIOS) {
    for (const policy of scenario.policies) {
      test(`sends ${scenario.name} unaltered to the pty (${policy})`, async ({
        orcaPage,
        testRepoPath
      }, testInfo) => {
        await applyImePlatformPolicy(orcaPage, policy)
        await expectImePlatformPolicy(orcaPage, policy)
        await narrowPaneBySplitting(orcaPage, 2)

        const arena = await openTerminalImePaneArena(orcaPage)
        const reader = createTerminalImeByteReader(testRepoPath, 1)
        let completed = false
        try {
          await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)

          const observedCols = await waitForSettledCols(orcaPage, arena.ptyId)
          const run = buildHangulRun(scenario.syllableCount(observedCols))
          const prefix = scenario.offsetByOneCell ? OFFSET_KEY.key : ''
          const expectedText = prefix + run.map((syllable) => syllable.text).join('')
          testInfo.annotations.push({
            type: 'wrap-regime',
            description: `${observedCols} cols, ${run.length} syllables, offset ${prefix.length}`
          })

          const startRow = (await readPaneGrid(orcaPage, arena.ptyId)).cursorRow
          if (scenario.offsetByOneCell) {
            await dispatchImeRewrittenPrintableKey(arena.session, OFFSET_KEY)
          }
          await scenario.drive(arena.session, orcaPage, run)
          // The guard that stops this passing by measuring nothing: the echoed run has to have
          // pushed the cursor onto a later row, which is the wrap the whole spec is about.
          await expect
            .poll(async () => (await readPaneGrid(orcaPage, arena.ptyId)).cursorRow, {
              timeout: 10_000,
              message: `run of ${run.length} syllables never wrapped at ${observedCols} cols`
            })
            .toBeGreaterThan(startRow)

          await dispatchPlainEnter(arena.session)

          const received = await waitForTerminalImeBytes(orcaPage, reader, 20_000)
          expectExactPtyInput(received, expectedText)
          completed = true
        } finally {
          await closeTerminalImePaneArena(arena, testInfo, 'hangul-wrap-boundary-bytes', !completed)
          removeTerminalImeByteReader(reader)
        }
      })
    }
  }
})
