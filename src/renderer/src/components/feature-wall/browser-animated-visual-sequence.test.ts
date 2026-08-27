import { describe, expect, it } from 'vitest'
import {
  BROWSER_PROMPT_TEXT,
  browserPhaseAtLeast,
  isBrowserSplitPhase,
  type BrowserVisualPhase
} from './browser-animated-visual-phase'
import {
  runBrowserVisualSequence,
  type BrowserVisualTarget
} from './browser-animated-visual-sequence'

describe('browser animated visual sequence', () => {
  it('preserves the storyboard phases, targets, and cycle duration', async () => {
    let cancelled = false
    const waits: number[] = []
    const phases: BrowserVisualPhase[] = []
    const typedChars: number[] = []
    const targets: [BrowserVisualTarget, number | undefined, number | undefined][] = []
    let clickRings = 0
    let menuCaptures = 0
    let anchorCaptures = 0
    let flashes = 0
    let completions = 0

    await runBrowserVisualSequence({
      isCancelled: () => cancelled,
      wait: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
      setPhase: (phase) => phases.push(phase),
      setTypedChars: (count) => typedChars.push(count),
      setCursorToTarget: (target, offsetX, offsetY) => targets.push([target, offsetX, offsetY]),
      resetCursor: () => {},
      pulseClickRing: () => {
        clickRings += 1
      },
      captureMenuOffset: () => {
        menuCaptures += 1
      },
      captureAnnotateAnchor: () => {
        anchorCaptures += 1
      },
      flashScreenshot: () => {
        flashes += 1
      },
      completeCycle: () => {
        completions += 1
        cancelled = true
      }
    })

    expect(phases).toEqual([
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
    ])
    expect(typedChars).toEqual([
      0,
      ...Array.from({ length: BROWSER_PROMPT_TEXT.length }, (_, index) => index + 1)
    ])
    expect(targets).toEqual([
      ['newtab-button', undefined, undefined],
      ['newtab-row', 6, undefined],
      ['starter-card', 0, -8],
      ['send-button', undefined, undefined],
      ['cta', undefined, undefined]
    ])
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(18_666)
    expect({ clickRings, menuCaptures, anchorCaptures, flashes, completions }).toEqual({
      clickRings: 5,
      menuCaptures: 1,
      anchorCaptures: 1,
      flashes: 1,
      completions: 1
    })
  })

  it('opens the split at working and keeps ordered phase comparisons', () => {
    expect(isBrowserSplitPhase('handoff')).toBe(false)
    expect(isBrowserSplitPhase('working')).toBe(true)
    expect(browserPhaseAtLeast('updated', 'working')).toBe(true)
    expect(browserPhaseAtLeast('inspect', 'updated')).toBe(false)
  })
})
