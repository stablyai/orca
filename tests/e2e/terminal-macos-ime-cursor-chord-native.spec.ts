import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressChordWithSeparateModifier } from './macos-input-source-driver'
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
 *   - ABC control: no IME anywhere, movement bytes flow alone.
 *
 * Run-validity guards follow terminal-macos-korean-chord-commit-native.spec.ts: the selected
 * input source is read back, and a composition must actually form before any target key is
 * pressed, so a run where the IME never engaged is void rather than green.
 */

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
const KOTOERI_ROMAJI_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese'
// Selecting a Kotoeri MODE fails with paramErr (-50) while its parent input method is disabled,
// and the parent has a different InputSourceID, so select-input-source.swift's own
// enable-everything-for-this-id pass cannot reach it. Enable the parent first.
const KOTOERI_ROMAJI_PARENT_ID = 'com.apple.inputmethod.Kotoeri.RomajiTyping'
const ABC_ID = 'com.apple.keylayout.ABC'
const SELECT_INPUT_SOURCE = path.resolve(__dirname, 'select-input-source.swift')

const KEY = {
  left: 123,
  right: 124,
  return: 36,
  backspace: 51
} as const

function selectInputSource(id: string): void {
  execFileSync('swift', [SELECT_INPUT_SOURCE, id])
}

/** Enable (without selecting) every TIS entry whose InputSourceID matches `id`. */
function enableInputSource(id: string): void {
  const source = `
import Carbon
let properties = [kTISPropertyInputSourceID: ${JSON.stringify(id)} as CFString] as CFDictionary
let sources = TISCreateInputSourceList(properties, true).takeRetainedValue() as! [TISInputSource]
guard !sources.isEmpty else { exit(3) }
for candidate in sources { TISEnableInputSource(candidate) }
exit(0)
`
  execFileSync('swift', ['-'], { input: source })
}

function focusApp(processId: number): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'delay 0.3'
  ])
}

/** Bounce focus away and back so the app's input context re-reads the selected input source. */
function bounceFocus(processId: number): void {
  execFileSync('osascript', ['-e', 'tell application "Finder" to activate', '-e', 'delay 0.4'])
  focusApp(processId)
}

/** Type key codes one at a time with a delay so the IME engages on every keystroke. */
function typeKeyCodes(processId: number, keyCodes: readonly number[]): void {
  focusApp(processId)
  execFileSync('osascript', [
    '-e',
    'tell application "System Events"',
    '-e',
    `repeat with currentKeyCode in {${keyCodes.join(', ')}}`,
    '-e',
    'key code (currentKeyCode as integer)',
    '-e',
    'delay 0.12',
    '-e',
    'end repeat',
    '-e',
    'end tell'
  ])
}

/**
 * The chord itself, pressed by the OS so the IME decides how to resolve it. A modifier goes as
 * its own key event rather than folded into the target key's flags, because macOS delivers no
 * keyup for a key released while Command is held: the modifier's release is the only end that
 * gesture has, and `using command down` never produces one.
 */
function pressChord(processId: number, keyCode: number, modifier?: 'command' | 'option'): void {
  if (modifier) {
    pressChordWithSeparateModifier(processId, keyCode, modifier)
    return
  }
  focusApp(processId)
  execFileSync('osascript', ['-e', `tell application "System Events" to key code ${keyCode}`])
}

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
  pressChord(processId, KEY.return)
  try {
    return await waitForTerminalImeBytes(page, reader, 5_000)
  } catch {
    pressChord(processId, KEY.return)
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

        pressChord(processId, KEY.left, chord.modifier)
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

      pressChord(processId, KEY.left, 'command')
      // Recorded: Kotoeri swallows the chord — no commit, no composition event. The preedit
      // surviving the press is the half of #12871 that held on main and must keep holding.
      await orcaPage.waitForTimeout(700)
      await expect.poll(() => readActiveComposition(orcaPage)).toMatch(/[ぁ-ん]/)

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

      pressChord(processId, KEY.left, 'command')
      pressChord(processId, KEY.left, 'option')

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
