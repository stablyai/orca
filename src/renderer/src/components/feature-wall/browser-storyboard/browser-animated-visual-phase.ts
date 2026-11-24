import type { RefObject } from 'react'

export const BROWSER_PROMPT_TEXT = 'Make Starter card stand out'

export type BrowserVisualPhase =
  | 'idle'
  | 'newtab-approach'
  | 'newtab-click'
  | 'newtab-row-approach'
  | 'newtab-row-click'
  | 'tab-revealed'
  | 'approach-card'
  | 'inspect'
  | 'annotate'
  | 'send-approach'
  | 'send-click'
  | 'handoff'
  | 'working'
  | 'updated'
  | 'verify-intent'
  | 'click-approach'
  | 'click-press'
  | 'navigated'
  | 'screenshot-line'
  | 'screenshot-flash'
  | 'verified'

export type BrowserVisualPoint = {
  x: number
  y: number
}

export type BrowserVisualAnchor = {
  left: number
  top: number
}

export type BrowserVisualTargetRefs = {
  browserPageRef: RefObject<HTMLDivElement | null>
  titlebarRef: RefObject<HTMLDivElement | null>
  newtabButtonRef: RefObject<HTMLSpanElement | null>
  newtabRowRef: RefObject<HTMLDivElement | null>
  starterCardRef: RefObject<HTMLDivElement | null>
  ctaRef: RefObject<HTMLSpanElement | null>
  sendButtonRef: RefObject<HTMLSpanElement | null>
}

export type BrowserVisualState = {
  phase: BrowserVisualPhase
  typedChars: number
  flashKey: number
  clickRingKey: number
  clickRingVisible: boolean
  menuOffsetX: number
  annotateAnchor: BrowserVisualAnchor
  cursorPosition: BrowserVisualPoint
}

const PHASE_ORDER: readonly BrowserVisualPhase[] = [
  'idle',
  'newtab-approach',
  'newtab-click',
  'newtab-row-approach',
  'newtab-row-click',
  'tab-revealed',
  'approach-card',
  'inspect',
  'annotate',
  'send-approach',
  'send-click',
  'handoff',
  'working',
  'updated',
  'verify-intent',
  'click-approach',
  'click-press',
  'navigated',
  'screenshot-line',
  'screenshot-flash',
  'verified'
]

const SPLIT_PHASES: readonly BrowserVisualPhase[] = [
  'working',
  'updated',
  'verify-intent',
  'click-approach',
  'click-press',
  'navigated',
  'screenshot-line',
  'screenshot-flash',
  'verified'
]

export const BROWSER_REDUCED_MOTION_STATE: BrowserVisualState = {
  phase: 'verified',
  typedChars: BROWSER_PROMPT_TEXT.length,
  flashKey: 0,
  clickRingKey: 0,
  clickRingVisible: false,
  menuOffsetX: 0,
  annotateAnchor: { left: 116, top: 70 },
  cursorPosition: { x: 40, y: 18 }
}

export function browserPhaseAtLeast(
  current: BrowserVisualPhase,
  target: BrowserVisualPhase
): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target)
}

export function isBrowserSplitPhase(phase: BrowserVisualPhase): boolean {
  return SPLIT_PHASES.includes(phase)
}
