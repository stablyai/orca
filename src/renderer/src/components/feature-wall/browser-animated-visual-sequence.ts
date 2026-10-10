import { BROWSER_PROMPT_TEXT, type BrowserVisualPhase } from './browser-animated-visual-phase'

const PRE_INTRO_MS = 600
const NEWTAB_APPROACH_MS = 700
const NEWTAB_CLICK_MS = 180
const NEWTAB_DWELL_MS = 700
const NEWTAB_ROW_HOVER_MS = 1050
const NEWTAB_ROW_CLICK_MS = 220
const TAB_REVEAL_MS = 500
const APPROACH_CARD_MS = 900
const INSPECT_MS = 700
const ANNOTATE_OPEN_MS = 360
const ANNOTATE_TYPE_INTERVAL_MS = 58
const ANNOTATE_HOLD_MS = 900
const SEND_APPROACH_MS = 500
const SEND_CLICK_MS = 250
const HANDOFF_MS = 200
const WORKING_LINE_STAGGER_MS = 260
const WORKING_HOLD_MS = 1400
const UPDATED_HOLD_MS = 900
const VERIFY_INTENT_MS = 1100
const CLICK_APPROACH_MS = 620
const CLICK_PRESS_MS = 280
const NAVIGATED_HOLD_MS = 700
const SCREENSHOT_LINE_HOLD_MS = 420
const SCREENSHOT_FLASH_HOLD_MS = 700
const VERIFIED_HOLD_MS = 2400
const RESET_HOLD_MS = 300

export const BROWSER_CLICK_RING_MS = 460

export type BrowserVisualTarget =
  | 'newtab-button'
  | 'newtab-row'
  | 'starter-card'
  | 'send-button'
  | 'cta'

export type BrowserVisualSequenceControls = {
  isCancelled: () => boolean
  wait: (ms: number) => Promise<void>
  setPhase: (phase: BrowserVisualPhase) => void
  setTypedChars: (count: number) => void
  setCursorToTarget: (target: BrowserVisualTarget, offsetX?: number, offsetY?: number) => void
  resetCursor: () => void
  pulseClickRing: () => void
  captureMenuOffset: () => void
  captureAnnotateAnchor: () => void
  flashScreenshot: () => void
  completeCycle: () => void
}

async function pause(controls: BrowserVisualSequenceControls, ms: number): Promise<boolean> {
  await controls.wait(ms)
  return controls.isCancelled()
}

export async function runBrowserVisualSequence(
  controls: BrowserVisualSequenceControls
): Promise<void> {
  while (!controls.isCancelled()) {
    controls.setPhase('idle')
    controls.setTypedChars(0)
    controls.resetCursor()
    if (await pause(controls, PRE_INTRO_MS)) {
      return
    }

    controls.setCursorToTarget('newtab-button')
    controls.setPhase('newtab-approach')
    if (await pause(controls, NEWTAB_APPROACH_MS)) {
      return
    }

    controls.setPhase('newtab-click')
    controls.pulseClickRing()
    controls.captureMenuOffset()
    if (await pause(controls, NEWTAB_CLICK_MS)) {
      return
    }
    if (await pause(controls, NEWTAB_DWELL_MS)) {
      return
    }

    controls.setCursorToTarget('newtab-row', 6)
    controls.setPhase('newtab-row-approach')
    if (await pause(controls, NEWTAB_ROW_HOVER_MS)) {
      return
    }

    controls.setPhase('newtab-row-click')
    controls.pulseClickRing()
    if (await pause(controls, NEWTAB_ROW_CLICK_MS)) {
      return
    }
    controls.setPhase('tab-revealed')
    if (await pause(controls, TAB_REVEAL_MS)) {
      return
    }

    controls.setCursorToTarget('starter-card', 0, -8)
    controls.setPhase('approach-card')
    if (await pause(controls, APPROACH_CARD_MS)) {
      return
    }

    controls.setPhase('inspect')
    controls.pulseClickRing()
    if (await pause(controls, INSPECT_MS)) {
      return
    }

    controls.captureAnnotateAnchor()
    controls.setPhase('annotate')
    if (await pause(controls, ANNOTATE_OPEN_MS)) {
      return
    }
    for (let i = 1; i <= BROWSER_PROMPT_TEXT.length; i += 1) {
      if (controls.isCancelled()) {
        return
      }
      controls.setTypedChars(i)
      if (await pause(controls, ANNOTATE_TYPE_INTERVAL_MS)) {
        return
      }
    }
    if (await pause(controls, ANNOTATE_HOLD_MS)) {
      return
    }

    controls.setCursorToTarget('send-button')
    controls.setPhase('send-approach')
    if (await pause(controls, SEND_APPROACH_MS)) {
      return
    }

    controls.setPhase('send-click')
    controls.pulseClickRing()
    if (await pause(controls, SEND_CLICK_MS)) {
      return
    }

    controls.setPhase('handoff')
    if (await pause(controls, HANDOFF_MS)) {
      return
    }

    controls.setPhase('working')
    if (await pause(controls, WORKING_LINE_STAGGER_MS * 2)) {
      return
    }
    if (await pause(controls, WORKING_HOLD_MS)) {
      return
    }

    controls.setPhase('updated')
    if (await pause(controls, UPDATED_HOLD_MS)) {
      return
    }

    controls.setPhase('verify-intent')
    if (await pause(controls, VERIFY_INTENT_MS)) {
      return
    }

    controls.setCursorToTarget('cta')
    controls.setPhase('click-approach')
    if (await pause(controls, CLICK_APPROACH_MS)) {
      return
    }

    controls.setPhase('click-press')
    controls.pulseClickRing()
    if (await pause(controls, CLICK_PRESS_MS)) {
      return
    }

    controls.setPhase('navigated')
    if (await pause(controls, NAVIGATED_HOLD_MS)) {
      return
    }

    controls.setPhase('screenshot-line')
    if (await pause(controls, SCREENSHOT_LINE_HOLD_MS)) {
      return
    }

    controls.setPhase('screenshot-flash')
    controls.flashScreenshot()
    if (await pause(controls, SCREENSHOT_FLASH_HOLD_MS)) {
      return
    }

    controls.setPhase('verified')
    if (await pause(controls, VERIFIED_HOLD_MS)) {
      return
    }
    controls.completeCycle()
    if (await pause(controls, RESET_HOLD_MS)) {
      return
    }
  }
}
