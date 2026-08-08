/**
 * #11504 recon matrix: which native macOS key sequence makes AppKit emit the delayed
 * `insertText ". "` that stock xterm forwards to the PTY.
 *
 * Why this exists: `terminal-macos-automatic-period-native.spec.ts` already recorded a live
 * Korean run with `NSAutomaticPeriodSubstitutionEnabled=true` and got `아 ` with no trailing
 * `. ` — so the reporter's "one space is enough" shape did NOT reproduce under a single Space.
 * That leaves the trigger sequence unknown, and a known-bad packaged reproduction cannot be
 * built on an unknown trigger. This harness sweeps the candidates in one app instance and
 * records, per arm, the full DOM trace (with `timeStamp`, so the reporter's +149 ms offset is
 * measurable) and xterm `onData` — the boundary that decides whether the substitution is
 * forwarded to the shell at all. Deliberately no PTY-child reader: that needs a working `node`
 * inside the pane, and a reader that fails to start aborts the sweep before it records anything.
 *
 * It asserts preconditions, not outcomes. An arm whose trace carries no keyCode 229 and no
 * `compositionstart` is recorded `void: true` rather than read as a clean negative — the
 * failure mode where a reverted input source records raw QWERTY under a correct-looking pref.
 * The same-run Latin control exists for the same reason: if the Korean arms and the ABC arm
 * emit byte-identical output, no IME ran.
 *
 * The pref is read from the live system at run time, not asserted as a literal, so the JSON
 * binds each arm to the setting that was actually in force.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace,
  type TerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'

const ABC_ID = 'com.apple.keylayout.ABC'
const KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'

/** macOS virtual key codes. Under 2-Set Korean d=ㅇ and k=ㅏ, so [D, K] composes 아. */
const KEY_A = 0
const KEY_B = 11
const KEY_D = 2
const KEY_K = 40
const KEY_S = 1
const KEY_G = 5
const KEY_SPACE = 49
const KEY_ENTER = 36
const KEY_ESCAPE = 53

const WARM_UP_KEY_CODES = [KEY_G, KEY_K, KEY_S] as const
const WARM_UP_ATTEMPT_LIMIT = 6
/** The reporter's substitution lands +149 ms after `compositionend`; this dwarfs it. */
const SETTLE_MS = 1_800

type Arm = {
  name: string
  source: string
  keys: readonly number[]
  why: string
}

const ARMS: readonly Arm[] = [
  {
    name: 'latin-double-space',
    source: ABC_ID,
    keys: [KEY_A, KEY_B, KEY_SPACE, KEY_SPACE],
    why: 'Gate: is AppKit period substitution reachable in this app at all, absent any IME?'
  },
  {
    name: 'latin-single-space',
    source: ABC_ID,
    keys: [KEY_A, KEY_B, KEY_SPACE],
    why: 'Negative control for the gate above.'
  },
  {
    name: 'korean-single-space',
    source: KOREAN_ID,
    keys: [KEY_D, KEY_K, KEY_SPACE],
    why: "The reporter's stated shape: one Space commits 아 and is said to be enough."
  },
  {
    name: 'korean-double-space',
    source: KOREAN_ID,
    keys: [KEY_D, KEY_K, KEY_SPACE, KEY_SPACE],
    why: 'The classic double-space rule, with the commit supplying neither slot.'
  },
  {
    name: 'korean-word-space-word-space',
    source: KOREAN_ID,
    keys: [KEY_D, KEY_K, KEY_SPACE, KEY_D, KEY_K, KEY_SPACE],
    why: 'Word-separating spaces in running Hangul, the reporter described typing prose.'
  },
  {
    name: 'korean-longer-word-double-space',
    source: KOREAN_ID,
    keys: [KEY_G, KEY_K, KEY_S, KEY_SPACE, KEY_SPACE],
    why: 'A closed syllable (한) before the spaces, in case the trigger needs a final jamo.'
  }
]

type ArmResult = {
  name: string
  source: string
  keys: readonly number[]
  why: string
  inputSourceIdAfterKeys: string
  has229: boolean
  compositionStartCount: number
  compositionEndCount: number
  void: boolean
  insertTextAfterCompositionEnd: readonly { data: string | null; offsetMs: number }[]
  onDataAfterKeys: readonly string[]
  onDataFinal: readonly string[]
  terminalTail: string
  traceAfterKeys: TerminalImeBoundaryTrace
  traceFinal: TerminalImeBoundaryTrace
}

function pressKeyCodes(processId: number, keyCodes: readonly number[]): void {
  execFileSync('osascript', [
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
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

function selectInputSource(id: string): void {
  execFileSync('swift', [path.join(process.cwd(), 'tests', 'e2e', 'select-input-source.swift'), id])
}

/** Why: an app adopts an input source when it *activates*, not when the pref changes. */
function reactivateApp(processId: number): void {
  execFileSync('osascript', [
    '-e',
    'tell application "Finder" to activate',
    '-e',
    'delay 0.2',
    '-e',
    `tell application "System Events" to set frontmost of first application process whose unix id is ${processId} to true`,
    '-e',
    'delay 0.2'
  ])
}

function readAutomaticPeriodPreference(): string {
  try {
    return execFileSync('defaults', ['read', '-g', 'NSAutomaticPeriodSubstitutionEnabled'], {
      encoding: 'utf8'
    }).trim()
  } catch (error) {
    return `unset (${(error as Error).message.split('\n')[0]})`
  }
}

function readGitHead(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/** Why: the system source reverts on its own within seconds and a cold IME delivers its first
 *  jamo as non-composing insertText. Warm until a real keyCode 229 lands. */
async function establishLiveKoreanIme(page: Page, processId: number): Promise<boolean> {
  await installTerminalImeBoundaryProbe(page)
  try {
    for (let attempt = 0; attempt < WARM_UP_ATTEMPT_LIMIT; attempt += 1) {
      selectInputSource(KOREAN_ID)
      reactivateApp(processId)
      pressKeyCodes(processId, WARM_UP_KEY_CODES)
      pressKeyCodes(processId, [KEY_ESCAPE])
      const trace = await readTerminalImeBoundaryTrace(page)
      if (trace.dom.some((event) => event.keyCode === 229)) {
        return true
      }
    }
    return false
  } finally {
    await disposeTerminalImeBoundaryProbe(page)
  }
}

/** Offsets every post-`compositionend` `insertText` against the last `compositionend`, which is
 *  the measurement the reporter's "+149 ms" is expressed in. */
function insertTextOffsets(
  trace: TerminalImeBoundaryTrace
): { data: string | null; offsetMs: number }[] {
  const compositionEnds = trace.dom.filter((event) => event.type === 'compositionend')
  const lastEnd = compositionEnds.at(-1)
  return trace.dom
    .filter((event) => event.type === 'input' && event.inputType === 'insertText')
    .map((event) => ({
      data: event.data,
      offsetMs: lastEnd ? (event.timeStamp ?? 0) - (lastEnd.timeStamp ?? 0) : Number.NaN
    }))
}

test.describe('#11504 macOS automatic period substitution matrix @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_PERIOD !== '1',
    'Requires explicit native macOS period-substitution evidence mode'
  )

  test('sweeps candidate trigger sequences for the delayed insertText', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const page = orcaPage
    const processId = electronApp.process().pid!
    const label = process.env.ORCA_E2E_PERIOD_LABEL ?? 'unlabelled'

    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)

    const ptyId = await waitForActivePanePtyId(page)
    await focusActiveTerminalInput(page)

    const imeWarmed = await establishLiveKoreanIme(page, processId)

    const results: ArmResult[] = []
    let sweepError: string | null = null
    try {
      for (const arm of ARMS) {
        // Ctrl-C rather than a shell command: the sweep must not depend on anything being
        // executable inside the pane's PTY.
        await sendToTerminal(page, ptyId, '\x03')
        await focusActiveTerminalInput(page)
        try {
          await installTerminalImeBoundaryProbe(page)

          selectInputSource(arm.source)
          reactivateApp(processId)
          pressKeyCodes(processId, arm.keys)
          await page.waitForTimeout(SETTLE_MS)

          const traceAfterKeys = await readTerminalImeBoundaryTrace(page)
          const inputSourceIdAfterKeys = await page.evaluate(() =>
            window.api.app.getKeyboardInputSourceId()
          )

          pressKeyCodes(processId, [KEY_ENTER])
          await page.waitForTimeout(600)
          const traceFinal = await readTerminalImeBoundaryTrace(page)
          const terminalTail = (await getTerminalContent(page, 4_000)).slice(-400)

          const has229 = traceAfterKeys.dom.some((event) => event.keyCode === 229)
          const compositionStartCount = traceAfterKeys.dom.filter(
            (event) => event.type === 'compositionstart'
          ).length
          results.push({
            name: arm.name,
            source: arm.source,
            keys: arm.keys,
            why: arm.why,
            inputSourceIdAfterKeys,
            has229,
            compositionStartCount,
            compositionEndCount: traceAfterKeys.dom.filter(
              (event) => event.type === 'compositionend'
            ).length,
            // A Korean arm with no live IME is not a clean negative; it is no evidence at all.
            void: arm.source === KOREAN_ID && (!has229 || compositionStartCount === 0),
            insertTextAfterCompositionEnd: insertTextOffsets(traceAfterKeys),
            onDataAfterKeys: traceAfterKeys.onData,
            onDataFinal: traceFinal.onData,
            terminalTail,
            traceAfterKeys,
            traceFinal
          })
        } finally {
          await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
        }
      }
    } catch (error) {
      sweepError = (error as Error).message
    } finally {
      selectInputSource(ABC_ID)
    }

    const body = `${JSON.stringify(
      {
        label,
        host: execFileSync('hostname', { encoding: 'utf8' }).trim(),
        macosVersion: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
        gitHead: readGitHead(),
        automaticPeriodPreference: readAutomaticPeriodPreference(),
        imeWarmed,
        sweepError,
        results
      },
      null,
      2
    )}\n`
    const evidenceDir = path.join(process.cwd(), 'test-results', 'wave7-11504-period-matrix')
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(path.join(evidenceDir, `${label}.json`), body)
    await testInfo.attach(`wave7-11504-period-matrix-${label}.json`, {
      body,
      contentType: 'application/json'
    })

    // Preconditions only. The outcome is what this run is here to discover.
    expect(sweepError).toBeNull()
    expect(imeWarmed).toBe(true)
    const koreanArms = results.filter((result) => result.source === KOREAN_ID)
    expect(koreanArms.filter((result) => !result.void).length).toBeGreaterThan(0)
    const latinSingle = results.find((result) => result.name === 'latin-single-space')
    const koreanSingle = results.find((result) => result.name === 'korean-single-space')
    // Why: byte-identical Korean and Latin arms mean the IME never ran and the sweep is void.
    expect(koreanSingle?.onDataFinal.join('')).not.toBe(latinSingle?.onDataFinal.join(''))
  })
})
