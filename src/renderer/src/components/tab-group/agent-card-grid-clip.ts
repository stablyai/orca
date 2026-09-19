import { useLayoutEffect, useState } from 'react'

// Why this exists: a retained pane is a sibling of the agent-cards grid, not a descendant, so the
// grid's overflow never clips it. Without an explicit clip a half-scrolled card keeps painting (and
// taking clicks) over the tab strip. Clipping instead of hiding keeps a partly visible card live.

const AGENT_CARDS_VIEWPORT_SELECTOR = '[data-orca-agent-cards]'

type EdgeRect = {
  top: number
  right: number
  bottom: number
  left: number
}

export type AgentCardGridAnchor = {
  /** The card body the pane is anchored to; it is the pane's box, measured a frame earlier. */
  body: HTMLElement
  viewport: HTMLElement
}

/** `clip-path` trimming `pane` to the part still inside `viewport`, '' when the pane already fits. */
export function agentCardGridClipPath(pane: EdgeRect, viewport: EdgeRect): string {
  // Ceil so a sub-pixel overhang is clipped rather than leaked.
  const top = Math.ceil(Math.max(0, viewport.top - pane.top))
  const right = Math.ceil(Math.max(0, pane.right - viewport.right))
  const bottom = Math.ceil(Math.max(0, pane.bottom - viewport.bottom))
  const left = Math.ceil(Math.max(0, viewport.left - pane.left))
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    return ''
  }
  return `inset(${top}px ${right}px ${bottom}px ${left}px)`
}

/** The card body and its scrolling grid, or null when `groupId` is an ordinary split group. */
export function findAgentCardGridAnchor(groupId: string): AgentCardGridAnchor | null {
  for (const candidate of document.querySelectorAll<HTMLElement>('[data-tab-group-body-id]')) {
    if (candidate.dataset.tabGroupBodyId !== groupId) {
      continue
    }
    const viewport = candidate.closest<HTMLElement>(AGENT_CARDS_VIEWPORT_SELECTOR)
    return viewport ? { body: candidate, viewport } : null
  }
  return null
}

/**
 * Keeps a card's retained pane inside the grid's scroll viewport. No-op for panes with no
 * agent-cards ancestor, so ordinary split panes attach nothing and stay unclipped.
 */
export function useAgentCardGridClip(
  overlayRef: React.RefObject<HTMLDivElement | null>,
  groupId: string | undefined,
  isVisible: boolean,
  /** Token that changes whenever the caller repositions the pane itself. */
  paneRevision?: unknown
): void {
  const [retriedForGroupId, setRetriedForGroupId] = useState<string | null>(null)
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    if (!overlay || !groupId || !isVisible) {
      return
    }
    const anchor = findAgentCardGridAnchor(groupId)
    if (!anchor) {
      // Why retry: the card body and its grid can commit a frame after this pane becomes
      // visible, and giving up permanently would leave it painting over the tab strip until the
      // next visibility flip. Once per placement, so an ordinary split pane (which never has a
      // grid) cannot re-arm every frame, while a later move into a card still gets its retry.
      if (retriedForGroupId === groupId) {
        return
      }
      const retry = requestAnimationFrame(() => {
        setRetriedForGroupId(groupId)
      })
      return () => {
        cancelAnimationFrame(retry)
      }
    }
    const { body, viewport } = anchor

    // Measured from the anchor body, not the pane: Chromium applies the anchor scroll offset a
    // frame late, so the pane's own rect inside a scroll handler is still the previous position.
    // Written straight to the node: a measure -> setState -> layout cycle here would feed the
    // fallback-rect/xterm-fit loop that already crashed this overlay once (React #185).
    const applyClip = (): void => {
      overlay.style.clipPath = agentCardGridClipPath(
        body.getBoundingClientRect(),
        viewport.getBoundingClientRect()
      )
    }

    applyClip()
    viewport.addEventListener('scroll', applyClip)
    window.addEventListener('resize', applyClip)
    const resizeObserver = new ResizeObserver(applyClip)
    resizeObserver.observe(viewport)
    resizeObserver.observe(body)
    // The track grows and reflows as cards are added or removed, which moves card bodies
    // without any scroll or window event.
    const track = viewport.firstElementChild
    if (track) {
      resizeObserver.observe(track)
    }
    return () => {
      viewport.removeEventListener('scroll', applyClip)
      window.removeEventListener('resize', applyClip)
      resizeObserver.disconnect()
      overlay.style.clipPath = ''
    }
  }, [groupId, isVisible, overlayRef, paneRevision, retriedForGroupId])
}
