import { useEffect, type RefObject } from 'react'
import { createAgentCursor, type AgentCursorController } from './agent-cursor-motion'
import { attachBrowserAgentCursorSink } from './browser-agent-activity-state'
import { readPrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'

const AGENT_ACTIVE_ATTRIBUTE = 'data-agent-active'

/** Whether a person could see the page right now; hidden pages take the cursor without waiting. */
function isOnScreen(page: HTMLElement, rect: DOMRect): boolean {
  return (
    document.visibilityState === 'visible' &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight &&
    page.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
}

/**
 * Draws the agent's glow and cursor over a page: its webview, or the frame of a streamed page.
 * The layer is created inside `getHost()`, which must stack above the page, only once an agent
 * drives the page, so other pages cost nothing.
 */
export function useBrowserAgentCursor(
  browserPageId: string,
  pageRef: RefObject<HTMLElement | null>,
  getHost: () => HTMLElement | null
): void {
  useEffect(() => {
    let drawn: { layer: HTMLDivElement; cursor: AgentCursorController } | null = null
    const awaited = new Set<number>()

    const removeDrawn = (): void => {
      drawn?.cursor.destroy()
      drawn?.layer.remove()
      drawn = null
    }

    const ensureDrawn = (
      host: HTMLElement
    ): { layer: HTMLDivElement; cursor: AgentCursorController } => {
      if (drawn?.layer.parentElement === host) {
        return drawn
      }
      removeDrawn()
      const layer = document.createElement('div')
      layer.className = 'browser-agent-cursor-layer'
      layer.setAttribute('aria-hidden', 'true')
      host.appendChild(layer)
      const cursor = createAgentCursor(layer, {
        reducedMotion: readPrefersReducedMotion,
        onArrived: (sequence) => {
          if (awaited.delete(sequence)) {
            window.api.browser.agentCursorArrived(sequence)
          }
        }
      })
      drawn = { layer, cursor }
      return drawn
    }

    const detach = attachBrowserAgentCursorSink(browserPageId, {
      show: (event) => {
        const pageElement = pageRef.current
        const host = getHost()
        const page = pageElement?.getBoundingClientRect()
        if (!pageElement || !host || !page || !isOnScreen(pageElement, page)) {
          // A hidden page has no box to map onto; the cursor returns at the agent's next action there.
          drawn?.cursor.setVisible(false)
          return false
        }
        const { layer, cursor } = ensureDrawn(host)
        layer.toggleAttribute(AGENT_ACTIVE_ATTRIBUTE, true)
        const layerRect = layer.getBoundingClientRect()
        const point = {
          x: page.left - layerRect.left + (event.x * page.width) / event.viewportWidth,
          y: page.top - layerRect.top + (event.y * page.height) / event.viewportHeight
        }
        if (event.awaitsArrival) {
          awaited.add(event.sequence)
        }
        cursor.moveTo(point, event.sequence)
        if (event.press) {
          cursor.press()
        }
        return true
      },
      setActive: (active) => {
        if (!active) {
          drawn?.layer.toggleAttribute(AGENT_ACTIVE_ATTRIBUTE, false)
          drawn?.cursor.setVisible(false)
          return
        }
        // The glow shows while the agent works, even before it moves the pointer.
        const host = getHost()
        if (host) {
          ensureDrawn(host).layer.toggleAttribute(AGENT_ACTIVE_ATTRIBUTE, true)
        }
      }
    })

    return () => {
      detach()
      removeDrawn()
    }
  }, [browserPageId, pageRef, getHost])
}
