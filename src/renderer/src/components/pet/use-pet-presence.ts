import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clamp01,
  initialPresence,
  type PetEdge,
  type PetPoint,
  type PetPresenceSnapshot
} from '../../../../shared/pet-presence'

/**
 * This window's side of pet presence (P2).
 *
 * Registers the window as a surface, heartbeats it, mirrors the authority's
 * state, and reports edge exits. It never decides anything: `holdsPet` is
 * whatever the authority last said, so when the pet walks onto another surface
 * this window simply stops drawing it.
 */

/** Heartbeat comfortably inside SURFACE_STALE_AFTER_MS (30s) so a brief hiccup
 *  cannot get a live window swept out from under the pet. */
const HEARTBEAT_MS = 8_000

/** How close to an edge counts as touching it, in normalized units. Roughly a
 *  pet's width on a typical window — tight enough that a pet strolling past
 *  mid-screen never trips it. */
const EDGE_THRESHOLD = 0.02

/** Which edge (if any) a normalized position is against. */
export function edgeAt(position: PetPoint): PetEdge | null {
  if (position.x <= EDGE_THRESHOLD) {
    return 'left'
  }
  if (position.x >= 1 - EDGE_THRESHOLD) {
    return 'right'
  }
  if (position.y <= EDGE_THRESHOLD) {
    return 'top'
  }
  if (position.y >= 1 - EDGE_THRESHOLD) {
    return 'bottom'
  }
  return null
}

function newSurfaceId(): string {
  // Per WINDOW, not per app: two Orca windows are two destinations the pet can
  // move between, which is the whole point of P2.
  return `desktop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export type PetPresenceBinding = {
  /** True when this window should be drawing the pet. */
  holdsPet: boolean
  /** Authority position, normalized 0..1. */
  position: PetPoint
  facing: 'left' | 'right'
  /** Edge the pet just arrived through, or null once acknowledged. */
  enteredFromEdge: PetEdge | null
  /** True when some OTHER live surface exists, i.e. leaving is possible. */
  canHandOff: boolean
  /** Report that the pet reached an edge. Safe to call spuriously — the
   *  authority ignores it unless this window holds the pet and a destination
   *  exists. */
  reportExit: (edge: PetEdge, position: PetPoint) => void
  acknowledgeEntry: () => void
}

export function usePetPresence(enabled: boolean): PetPresenceBinding {
  const surfaceIdRef = useRef<string>(newSurfaceId())
  const [snapshot, setSnapshot] = useState<PetPresenceSnapshot>(() => ({
    presence: initialPresence(Date.now()),
    surfaces: []
  }))
  const exitPendingRef = useRef(false)
  // Why track this: until the authority answers, and in any build or test env
  // where the presence API is absent, the pet must still be drawn. A missing
  // authority is not a reason for the pet to disappear — it degrades to the
  // old single-surface behaviour instead.
  const [authorityAnswered, setAuthorityAnswered] = useState(false)

  useEffect(() => {
    const api = window.api?.petPresence
    if (!enabled || !api) {
      return
    }
    const surfaceId = surfaceIdRef.current
    let disposed = false

    const apply = (next: PetPresenceSnapshot): void => {
      if (!disposed) {
        setSnapshot(next)
        setAuthorityAnswered(true)
      }
    }

    void api.registerSurface(surfaceId, 'desktop-window').then(apply)
    const unsubscribe = api.onChanged(apply)
    const heartbeat = setInterval(() => {
      void api.registerSurface(surfaceId, 'desktop-window').then(apply)
    }, HEARTBEAT_MS)

    return () => {
      disposed = true
      clearInterval(heartbeat)
      unsubscribe()
      // Why remove rather than let it go stale: closing a window should hand the
      // pet on immediately, not strand it for a 30s stale window.
      void api.removeSurface(surfaceId)
    }
  }, [enabled])

  const reportExit = useCallback((edge: PetEdge, position: PetPoint) => {
    const api = window.api?.petPresence
    // Why the in-flight guard: the roam loop runs every frame and would fire
    // dozens of exits while the pet sits against the wall waiting for the
    // authority to answer.
    if (!api || exitPendingRef.current) {
      return
    }
    exitPendingRef.current = true
    void api
      .reportExit(surfaceIdRef.current, edge, {
        x: clamp01(position.x),
        y: clamp01(position.y)
      })
      .then((next) => setSnapshot(next))
      .finally(() => {
        exitPendingRef.current = false
      })
  }, [])

  const acknowledgeEntry = useCallback(() => {
    const api = window.api?.petPresence
    if (!api) {
      return
    }
    void api.acknowledgeEntry(surfaceIdRef.current).then((next) => setSnapshot(next))
  }, [])

  const surfaceId = surfaceIdRef.current
  const { presence, surfaces } = snapshot
  return {
    // Optimistic before the authority has spoken: better a brief duplicate on a
    // second window than a pet that blinks out on every launch.
    holdsPet: authorityAnswered ? presence.surfaceId === surfaceId : true,
    position: presence.position,
    facing: presence.facing,
    enteredFromEdge: presence.enteredFromEdge,
    canHandOff: surfaces.some((surface) => surface.id !== surfaceId),
    reportExit,
    acknowledgeEntry
  }
}

/** Pixel position within a surface, as the overlay tracks it. */
type PixelPosition = { x: number; y: number }

function viewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') {
    return { width: 1, height: 1 }
  }
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Keeps a window's pixel-space pet in step with the authority's normalized
 * presence: reports edge contact so the pet can walk out, and adopts the
 * arrival position so it walks back in from the edge it crossed.
 *
 * Lives here rather than in PetOverlay so the overlay stays a renderer and all
 * the surface-crossing reasoning sits next to the rules it depends on.
 */
export function usePetSurfaceSync({
  presence,
  position,
  size,
  dragging,
  setPosition
}: {
  presence: PetPresenceBinding
  position: PixelPosition
  size: number
  dragging: boolean
  setPosition: (next: PixelPosition) => void
}): void {
  // Walk-off: when the roaming pet reaches an edge and another surface exists,
  // ask the authority to hand it on. Normalized because surfaces share no pixel
  // space. Dragging is excluded — carrying the pet to the edge yourself should
  // not fling it to another screen.
  useEffect(() => {
    if (!presence.holdsPet || !presence.canHandOff || dragging) {
      return
    }
    const viewport = viewportSize()
    const normalized = {
      x: viewport.width > size ? position.x / (viewport.width - size) : 0.5,
      y: viewport.height > size ? position.y / (viewport.height - size) : 0.5
    }
    const edge = edgeAt(normalized)
    if (edge) {
      presence.reportExit(edge, normalized)
    }
  }, [presence, position, size, dragging])

  // Arrival: adopt the authority's position so the pet enters from the edge it
  // crossed rather than reappearing wherever this window last left one.
  useEffect(() => {
    if (!presence.holdsPet || presence.enteredFromEdge === null) {
      return
    }
    const viewport = viewportSize()
    setPosition({
      x: presence.position.x * Math.max(0, viewport.width - size),
      y: presence.position.y * Math.max(0, viewport.height - size)
    })
    presence.acknowledgeEntry()
  }, [presence, size, setPosition])
}
