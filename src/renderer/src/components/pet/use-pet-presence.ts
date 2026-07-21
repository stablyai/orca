import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clamp01,
  edgeAtNormalized,
  initialPresence,
  type PetEdge,
  type PetPoint,
  type PetPresenceSnapshot,
  type PetSurfaceKind
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

/**
 * Which edge (if any) a normalized position is against.
 *
 * Delegates to the shared rules module rather than keeping a local threshold.
 * The local copy agreed with mobile's local copy and both disagreed with
 * `entryPointFor`, which is how an arriving pet landed already touching a wall
 * and bounced straight back — see EDGE_ENTRY_INSET.
 */
export const edgeAt = edgeAtNormalized

function newSurfaceId(kind: PetSurfaceKind): string {
  // Per WINDOW, not per app: two Orca windows are two destinations the pet can
  // move between, which is the whole point of P2. The kind prefix keeps ids
  // legible in logs when several surfaces are live.
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export type PetPresenceBinding = {
  /** True when this window should be drawing the pet. */
  holdsPet: boolean
  /** Authority position, normalized 0..1. */
  position: PetPoint
  facing: 'left' | 'right'
  /** Edge the pet just arrived through, or null once acknowledged. */
  enteredFromEdge: PetEdge | null
  /** WHICH pet the authority currently believes is travelling, or null before
   *  it has spoken. Exposed so a surface owning the operator's selection can
   *  notice the authority disagreeing and correct the record. */
  petId: string | null
  /** True when some OTHER live surface exists, i.e. leaving is possible. */
  canHandOff: boolean
  /** Report that the pet reached an edge. Safe to call spuriously — the
   *  authority ignores it unless this window holds the pet and a destination
   *  exists. */
  reportExit: (edge: PetEdge, position: PetPoint) => void
  acknowledgeEntry: () => void
}

export function usePetPresence(
  enabled: boolean,
  /** What this window is. Popouts are their own destination (P5), so a pet can
   *  walk from the main window into a detached panel canvas and back. */
  kind: PetSurfaceKind = 'desktop-window'
): PetPresenceBinding {
  const surfaceIdRef = useRef<string>(newSurfaceId(kind))
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

    void api.registerSurface(surfaceId, kind).then(apply)
    const unsubscribe = api.onChanged(apply)
    const heartbeat = setInterval(() => {
      void api.registerSurface(surfaceId, kind).then(apply)
    }, HEARTBEAT_MS)

    return () => {
      disposed = true
      clearInterval(heartbeat)
      unsubscribe()
      // Why remove rather than let it go stale: closing a window should hand the
      // pet on immediately, not strand it for a 30s stale window.
      void api.removeSurface(surfaceId)
    }
  }, [enabled, kind])

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
    petId: authorityAnswered ? presence.petId : null,
    canHandOff: surfaces.some((surface) => surface.id !== surfaceId),
    reportExit,
    acknowledgeEntry
  }
}

/**
 * Publish which pet the operator has selected, so identity travels with the pet.
 *
 * Desktop surfaces own that selection (it lives in the app store); a phone only
 * mirrors it. Before this, presence carried who held the pet and where but never
 * WHICH pet, so each surface picked its own sprite — the phone drew the first
 * pet in its bundle and the "handoff" was two different creatures taking turns.
 *
 * NOT idempotent across surfaces, despite what this comment used to claim.
 * "Every window reports the same value" held only while every window was
 * hydrated; a popout is not, and it published the store default. Only surfaces
 * entitled to speak may pass a non-null id — see PetOverlay's
 * `reportsPetIdentity`.
 *
 * Self-healing is the second half. Reporting keyed solely on the local id fires
 * once at mount and never again, so a single bad write STUCK: the authority
 * held `claude-the-mage`, the main window's own selection had not changed so
 * its effect never re-ran, and nothing on the mesh ever put the record right.
 * That is why the wall survived returning to the main canvas. Comparing against
 * the authority's value means any divergence is corrected by the surface that
 * actually owns the answer, on the next snapshot.
 *
 * Why the wall, and not merely a wrong sprite: the phone declares which pets it
 * can draw, and `pickHandoffTarget` refuses a surface that cannot draw the
 * current one (no silent substitution). `claude-the-mage` is an Orca bundled
 * pet, absent from the phone's 12 mesh-defaults, so the phone stopped being an
 * eligible destination and the pet had nowhere to go.
 */
export function usePetIdentityReporting(
  petId: string | null | undefined,
  /** What the authority currently holds, so a stale record can be corrected. */
  authorityPetId: string | null
): void {
  useEffect(() => {
    const api = window.api?.petPresence
    if (!api || !petId || authorityPetId === petId) {
      return
    }
    void api.setPetId(petId)
  }, [petId, authorityPetId])
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
