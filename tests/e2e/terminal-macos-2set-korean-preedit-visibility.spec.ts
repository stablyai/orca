/**
 * Pins the preedit overlay's *visibility* — not just its intent — during native macOS 2-Set
 * Korean composition.
 *
 * Why a live browser: happy-dom resolves the overlay's intent (the `active` class, its
 * textContent) but reports `display: block` in both states with all-zero rects, so a DOM-only
 * arm passes over an overlay that never renders. Only a real Electron window can tell the two
 * apart.
 *
 * `during.rect` is the single load-bearing assertion here. Measured against an overlay forced
 * to `max-width: 0; overflow: hidden` — invisible on screen — the `active` class, the
 * textContent, `display: block` AND `checkVisibility() === true` all still pass. The bounding
 * rect is the only signal that fails. Do not weaken it to a visibility or class check.
 *
 * Two macOS mechanisms make a Korean-looking precondition record raw QWERTY, and neither is
 * visible in the input-source pref. Both are handled in `establishLiveKoreanIme`:
 *
 *  1. The system input source reverts to the previous keyboard on its own ~7-8s after being
 *     set, so any source selected before launch is a race, and a pre-flight assertion
 *     certifies a source that will not be in force when the keys land. Select late, and
 *     assert *after* the IME is live rather than before.
 *  2. An app adopts a new input source when it *activates*, not when the pref changes. A
 *     source selected while the app is already frontmost never reaches its input context, so
 *     the selection must be followed by a focus bounce.
 *
 * A run that skips either emits the ASCII letters for the key codes below rather than Hangul,
 * with a correct-looking Korean id in the pref — the shape recorded in HAZARD-REGISTER.md E1.
 * The `has229` / `compositionstart` assertions exist to fail that run loudly.
 *
 * Values below were recorded from a live run under `com.apple.inputmethod.Korean.2SetKorean`;
 * see `11914-c3-live-preedit-visibility.txt` in the lane capture directory. That capture is
 * gitignored and is cited, never imported.
 *
 * Correction to this file's own landing commit (19a8d133db7), which said the spec had not been
 * executed in this form: it has. It passes on real hardware — 1 passed, 9.1s, rc=0 — and the
 * teeth check above was run against it rather than reasoned about. Both logs are sealed
 * alongside the capture. An earlier teeth attempt that injected the CSS mid-run tripped the
 * `hasActiveClass` poll instead of the rect assertion; it is inconclusive and excluded.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  disposeTerminalImeBoundaryProbe,
  installTerminalImeBoundaryProbe,
  readTerminalImeBoundaryTrace
} from './terminal-ime-boundary-probe'

const TWO_SET_KOREAN_ID = 'com.apple.inputmethod.Korean.2SetKorean'
/** ㅎㅏㄴ ㄱㅡ — commits 한 and leaves 그 in preedit. */
const HAN_GEU_KEY_CODES = [5, 40, 1, 15, 46] as const
const WARM_UP_KEY_CODES = [5, 40, 1] as const
const ESCAPE_KEY_CODE = 53
const ENTER_KEY_CODE = 36
const WARM_UP_ATTEMPT_LIMIT = 6

/** Recorded live. Widths are font-metric dependent, so the assertions below pin the
 *  discriminating properties rather than these exact floats. */
const RECORDED_SAMPLE = {
  baseline: { display: 'none', width: 0, height: 0, checkVisibility: false },
  during: { display: 'block', width: 15.84375, height: 16, checkVisibility: true, text: '그' },
  after: { display: 'none', width: 0, height: 0, checkVisibility: false },
  onData: ['한', '그', '\r']
} as const

type PreeditSample = {
  found: boolean
  hasActiveClass: boolean
  textContent: string
  rect: { width: number; height: number }
  checkVisibility: boolean | null
  display: string
  visibility: string
  maxWidth: string
  overflow: string
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

function samplePreedit(page: Page): Promise<PreeditSample> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const view = textarea?.parentElement?.querySelector<HTMLElement>('.composition-view') ?? null
    if (!view) {
      return {
        found: false,
        hasActiveClass: false,
        textContent: '',
        rect: { width: 0, height: 0 },
        checkVisibility: null,
        display: '',
        visibility: '',
        maxWidth: '',
        overflow: ''
      }
    }
    const style = getComputedStyle(view)
    const rect = view.getBoundingClientRect()
    return {
      found: true,
      hasActiveClass: view.classList.contains('active'),
      textContent: (view.textContent ?? '').replaceAll('‎', ''),
      rect: { width: rect.width, height: rect.height },
      checkVisibility: typeof view.checkVisibility === 'function' ? view.checkVisibility() : null,
      display: style.display,
      visibility: style.visibility,
      maxWidth: style.maxWidth,
      overflow: style.overflow
    }
  })
}

function selectKoreanInputSource(): void {
  execFileSync('swift', [
    path.join(process.cwd(), 'tests', 'e2e', 'select-input-source.swift'),
    TWO_SET_KOREAN_ID
  ])
}

/** Why: an app adopts a new input source when it *activates*, not when the pref changes, so a
 *  source selected while the app is already frontmost never reaches its input context. Bounce
 *  focus away and back to force the re-sync. */
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

/** Why: two independent failures make a Korean-looking precondition record ASCII — the system
 *  source reverts on its own within seconds of being set, and a cold IME delivers its first
 *  jamo as non-composing insertText. Neither is visible in the pref, so establish the IME at
 *  the boundary instead: re-select, re-activate, and warm until a real keyCode 229 lands. A
 *  lone jamo never wakes it; the unit that does is a multi-key sequence. */
async function establishLiveKoreanIme(page: Page, processId: number): Promise<boolean> {
  await installTerminalImeBoundaryProbe(page)
  try {
    for (let attempt = 0; attempt < WARM_UP_ATTEMPT_LIMIT; attempt += 1) {
      selectKoreanInputSource()
      reactivateApp(processId)
      pressKeyCodes(processId, WARM_UP_KEY_CODES)
      pressKeyCodes(processId, [ESCAPE_KEY_CODE])
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

test.describe('Native macOS 2-Set Korean preedit visibility @headful', () => {
  test.skip(
    process.platform !== 'darwin' || process.env.ORCA_E2E_NATIVE_MACOS_KOREAN !== '1',
    'Requires macOS with 2-Set Korean selected and Accessibility access'
  )

  test('renders the composing overlay and hides it either side', async ({
    electronApp,
    orcaPage
  }) => {
    const page = orcaPage
    const processId = electronApp.process().pid!
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)

    const ptyId = await waitForActivePanePtyId(page)
    await focusActiveTerminalInput(page)
    expect(await establishLiveKoreanIme(page, processId)).toBe(true)
    // Why: asserted after the IME is live, not before — the system source reverts on its own
    // within seconds, so a pre-flight read says nothing about the source that will be in force.
    await expect(page.evaluate(() => window.api.app.getKeyboardInputSourceId())).resolves.toBe(
      TWO_SET_KOREAN_ID
    )

    await installTerminalImeBoundaryProbe(page)
    let committed = false
    try {
      const baseline = await samplePreedit(page)
      expect(baseline.found).toBe(true)
      expect(baseline.hasActiveClass).toBe(false)
      expect(baseline.display).toBe(RECORDED_SAMPLE.baseline.display)
      expect(baseline.checkVisibility).toBe(RECORDED_SAMPLE.baseline.checkVisibility)
      expect(baseline.rect.width).toBe(RECORDED_SAMPLE.baseline.width)
      expect(baseline.rect.height).toBe(RECORDED_SAMPLE.baseline.height)

      pressKeyCodes(processId, HAN_GEU_KEY_CODES)
      await expect.poll(async () => (await samplePreedit(page)).hasActiveClass).toBe(true)
      const during = await samplePreedit(page)

      // Why: the precondition. Without an engaged IME the overlay assertions below are
      // vacuous — an ASCII passthrough leaves the overlay hidden for the honest reason.
      const composingTrace = await readTerminalImeBoundaryTrace(page)
      expect(composingTrace.dom.some((event) => event.keyCode === 229)).toBe(true)
      expect(
        composingTrace.dom.filter((event) => event.type === 'compositionstart').length
      ).toBeGreaterThan(0)

      expect(during.textContent).toBe(RECORDED_SAMPLE.during.text)
      expect(during.display).toBe(RECORDED_SAMPLE.during.display)
      expect(during.checkVisibility).toBe(RECORDED_SAMPLE.during.checkVisibility)
      expect(during.rect.width).toBeGreaterThan(0)
      expect(during.rect.height).toBeGreaterThan(0)
      expect(during.visibility).toBe('visible')
      // Why: an overlay laid out at maxWidth 0 with overflow hidden is invisible on screen and
      // indistinguishable from a rendered one to every non-geometric assertion.
      expect(during.maxWidth).not.toBe('0px')

      pressKeyCodes(processId, [ENTER_KEY_CODE])
      committed = true
      await expect.poll(async () => (await samplePreedit(page)).hasActiveClass).toBe(false)
      const after = await samplePreedit(page)
      expect(after.display).toBe(RECORDED_SAMPLE.after.display)
      expect(after.checkVisibility).toBe(RECORDED_SAMPLE.after.checkVisibility)
      expect(after.rect.width).toBe(RECORDED_SAMPLE.after.width)
      expect(after.rect.height).toBe(RECORDED_SAMPLE.after.height)

      expect((await readTerminalImeBoundaryTrace(page)).onData).toEqual([...RECORDED_SAMPLE.onData])
    } finally {
      await disposeTerminalImeBoundaryProbe(page).catch(() => undefined)
      if (!committed) {
        await sendToTerminal(page, ptyId, '\x03').catch(() => undefined)
      }
    }
  })
})
