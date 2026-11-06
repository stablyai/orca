import { createContext, useContext } from 'react'

/**
 * Where each granting control sits on screen, in panel-content coordinates (so the person
 * scrolling does not count as a move). Any change of a control's rect, including one caused by
 * a sibling or ancestor, restarts its settle window.
 */
export type PluginDeclarativeGestureGeometry = {
  /** Stable per id, so React does not re-attach (and reset) it on every render. */
  refFor: (id: string) => (element: Element | null) => void
  setContainer: (element: Element | null) => void
  /** Re-measures every control; call after each commit and right before judging a press. */
  sample: (now?: number) => void
  /** True when every control with this id has kept its rect for `settleMs` (and one exists). */
  isSettled: (id: string, now: number, settleMs: number) => boolean
}

/** 32-bit FNV-1a: a short id for long content. */
function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Ids a control is tracked under: its press callback, a Link's href, or a Markdown block (its
 *  links open only once the block itself has settled). */
export const pluginDeclarativeGestureId = {
  callback: (callback: string): string => `cb:${callback}`,
  href: (href: string): string => `href:${href}`,
  markdown: (content: string): string => `md:${content.length}:${contentHash(content)}`
}

type Placement = { id: string; rect: string; since: number }

export function createPluginDeclarativeGestureGeometry(
  clock: () => number
): PluginDeclarativeGestureGeometry {
  const placements = new Map<Element, Placement>()
  const refs = new Map<string, (element: Element | null) => void>()
  let container: Element | null = null
  // Elements by id, so a ref callback's null (detach) can find what it attached.
  const attached = new Map<string, Set<Element>>()

  const rectOf = (element: Element): string => {
    const box = element.getBoundingClientRect()
    const origin = container?.getBoundingClientRect()
    const left = box.left - (origin?.left ?? 0) + (container?.scrollLeft ?? 0)
    const top = box.top - (origin?.top ?? 0) + (container?.scrollTop ?? 0)
    return `${left},${top},${box.width},${box.height}`
  }

  return {
    refFor(id) {
      let ref = refs.get(id)
      if (!ref) {
        ref = (element) => {
          const elements = attached.get(id) ?? new Set<Element>()
          attached.set(id, elements)
          if (element) {
            elements.add(element)
            placements.set(element, { id, rect: rectOf(element), since: clock() })
            return
          }
          // React passes null on detach without saying which element; drop the disconnected ones.
          for (const known of elements) {
            if (!known.isConnected) {
              elements.delete(known)
              placements.delete(known)
            }
          }
        }
        refs.set(id, ref)
      }
      return ref
    },
    setContainer(element) {
      container = element
    },
    sample(now = clock()) {
      for (const [element, placement] of placements) {
        if (!element.isConnected) {
          placements.delete(element)
          continue
        }
        const rect = rectOf(element)
        if (rect !== placement.rect) {
          placements.set(element, { ...placement, rect, since: now })
        }
      }
    },
    isSettled(id, now, settleMs) {
      let found = false
      for (const placement of placements.values()) {
        if (placement.id === id) {
          if (now - placement.since < settleMs) {
            return false
          }
          found = true
        }
      }
      return found
    }
  }
}

export const PluginDeclarativeGestureContext =
  createContext<PluginDeclarativeGestureGeometry | null>(null)

/** The ref that tracks an element's placement under `id`, when the view tracks gestures. */
export function useGestureTrackRef(id: string): ((element: Element | null) => void) | undefined {
  return useContext(PluginDeclarativeGestureContext)?.refFor(id)
}
