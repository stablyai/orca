import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import {
  BROWSER_CLICK_RING_MS,
  runBrowserVisualSequence,
  type BrowserVisualTarget
} from './browser-animated-visual-sequence'
import type {
  BrowserVisualAnchor,
  BrowserVisualPhase,
  BrowserVisualPoint,
  BrowserVisualState,
  BrowserVisualTargetRefs
} from './browser-animated-visual-phase'

const INITIAL_CURSOR_POSITION: BrowserVisualPoint = { x: 40, y: 18 }
const INITIAL_ANNOTATE_ANCHOR: BrowserVisualAnchor = { left: 116, top: 70 }

export function useBrowserVisualTargetRefs(): BrowserVisualTargetRefs {
  const browserPageRef = useRef<HTMLDivElement | null>(null)
  const titlebarRef = useRef<HTMLDivElement | null>(null)
  const newtabButtonRef = useRef<HTMLSpanElement | null>(null)
  const newtabRowRef = useRef<HTMLDivElement | null>(null)
  const starterCardRef = useRef<HTMLDivElement | null>(null)
  const ctaRef = useRef<HTMLSpanElement | null>(null)
  const sendButtonRef = useRef<HTMLSpanElement | null>(null)

  return useMemo(
    () => ({
      browserPageRef,
      titlebarRef,
      newtabButtonRef,
      newtabRowRef,
      starterCardRef,
      ctaRef,
      sendButtonRef
    }),
    []
  )
}

function targetElement(
  refs: BrowserVisualTargetRefs,
  target: BrowserVisualTarget
): HTMLElement | null {
  if (target === 'newtab-button') {
    return refs.newtabButtonRef.current
  }
  if (target === 'newtab-row') {
    return refs.newtabRowRef.current
  }
  if (target === 'starter-card') {
    return refs.starterCardRef.current
  }
  if (target === 'send-button') {
    return refs.sendButtonRef.current
  }
  return refs.ctaRef.current
}

export function useBrowserAnimatedVisualStoryboard(
  refs: BrowserVisualTargetRefs,
  reducedMotion: boolean,
  onCycleComplete?: () => void
): BrowserVisualState {
  const [phase, setPhase] = useState<BrowserVisualPhase>('idle')
  const [typedChars, setTypedChars] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
  const [clickRingKey, setClickRingKey] = useState(0)
  const [clickRingVisible, setClickRingVisible] = useState(false)
  const [menuOffsetX, setMenuOffsetX] = useState(0)
  const [annotateAnchor, setAnnotateAnchor] = useState<BrowserVisualAnchor>(INITIAL_ANNOTATE_ANCHOR)
  const cursorPositionRef = useRef<BrowserVisualPoint>(INITIAL_CURSOR_POSITION)
  const [cursorPosition, setCursorPosition] = useState<BrowserVisualPoint>(INITIAL_CURSOR_POSITION)
  const completeCycle = useEffectEvent(() => onCycleComplete?.())

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(resolve, ms)
        timeouts.push(id)
      })
    const setCursorTo = (position: BrowserVisualPoint): void => {
      cursorPositionRef.current = position
      setCursorPosition(position)
    }
    const setCursorToTarget = (target: BrowserVisualTarget, offsetX = 0, offsetY = 0): void => {
      const page = refs.browserPageRef.current
      const element = targetElement(refs, target)
      if (!page || !element) {
        setCursorTo(cursorPositionRef.current)
        return
      }
      const pageRect = page.getBoundingClientRect()
      const elementRect = element.getBoundingClientRect()
      setCursorTo({
        x: elementRect.left - pageRect.left + elementRect.width / 2 - 8 + offsetX,
        y: elementRect.top - pageRect.top + elementRect.height / 2 - 8 + offsetY
      })
    }
    const pulseClickRing = (): void => {
      setClickRingKey((key) => key + 1)
      setClickRingVisible(true)
      const id = window.setTimeout(() => {
        if (!cancelled) {
          setClickRingVisible(false)
        }
      }, BROWSER_CLICK_RING_MS)
      timeouts.push(id)
    }

    void runBrowserVisualSequence({
      isCancelled: () => cancelled,
      wait,
      setPhase,
      setTypedChars,
      setCursorToTarget,
      resetCursor: () => {
        setClickRingVisible(false)
        setCursorTo(INITIAL_CURSOR_POSITION)
      },
      pulseClickRing,
      captureMenuOffset: () => {
        const titlebar = refs.titlebarRef.current
        const button = refs.newtabButtonRef.current
        if (!titlebar || !button) {
          return
        }
        setMenuOffsetX(button.getBoundingClientRect().left - titlebar.getBoundingClientRect().left)
      },
      captureAnnotateAnchor: () => {
        const page = refs.browserPageRef.current
        const card = refs.starterCardRef.current
        if (!page || !card) {
          return
        }
        const pageRect = page.getBoundingClientRect()
        const cardRect = card.getBoundingClientRect()
        setAnnotateAnchor({
          left: cardRect.right - pageRect.left + 6,
          top: cardRect.top - pageRect.top
        })
      },
      flashScreenshot: () => setFlashKey((key) => key + 1),
      completeCycle
    })

    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [refs, reducedMotion])

  return {
    phase,
    typedChars,
    flashKey,
    clickRingKey,
    clickRingVisible,
    menuOffsetX,
    annotateAnchor,
    cursorPosition
  }
}
