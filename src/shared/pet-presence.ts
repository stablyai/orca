/**
 * Pet presence: which surface currently holds the pet, and what happens when it
 * walks off an edge.
 *
 * The pet is EXCLUSIVE — it exists on exactly one surface at a time. That is
 * the whole feature: a desktop window, a popout, and a phone are destinations
 * a single creature moves between, not three copies of one creature. Every
 * rule here exists to keep two surfaces from both believing they hold it.
 *
 * Pure by design: no DOM, no Electron, no React Native. The main process owns
 * an instance of this state (single writer, node-b), every renderer reads it,
 * and the mobile app runs the identical module so the two screens can never
 * disagree about the rules.
 *
 * Coordinates are NORMALIZED (0..1 on each axis), never pixels. A 2560px
 * desktop window and a 1080px phone share no pixel space; normalized cross-axis
 * position is what makes "walked off the right at head height, arrived on the
 * left at head height" mean anything across surfaces of different shapes.
 */

export type PetSurfaceKind = 'desktop-window' | 'popout-window' | 'phone'

export type PetSurface = {
  id: string
  kind: PetSurfaceKind
  /** Last time this surface reported itself alive (ms epoch). */
  seenAt: number
  /**
   * Pet ids this surface can draw, or null for "anything".
   *
   * Desktop surfaces read sprites off disk and report null. A phone can only
   * draw what was compiled into its bundle, so it reports that list. Without
   * this, identity and location disagree: the phone receives a pet it has no
   * sheet for and draws whatever it has — which is how the operator watched a
   * gandalf walk off the desktop and a pepe walk onto the phone. A surface that
   * cannot draw the current pet is not a destination.
   */
  renderablePetIds: string[] | null
}

export type PetEdge = 'left' | 'right' | 'top' | 'bottom'

/** What every client reads: who holds the pet, and which surfaces exist. */
export type PetPresenceSnapshot = {
  presence: PetPresence
  surfaces: PetSurface[]
}

/** Normalized position within whichever surface currently holds the pet. */
export type PetPoint = { x: number; y: number }

export type PetPresence = {
  /** Surface currently holding the pet, or null when no surface is alive. */
  surfaceId: string | null
  /**
   * WHICH pet is travelling — the creature's identity, not just its location.
   *
   * Presence used to carry only who holds the pet and where, so each surface
   * picked its own sprite and the "handoff" was really two unrelated pets
   * taking turns being visible. Identity belongs here, next to position and
   * ownership, because it is the same fact: there is one pet.
   *
   * Null before any surface has reported the operator's selection.
   */
  petId: string | null
  position: PetPoint
  /** Which way the pet is facing, so an arrival animation can march inward. */
  facing: 'left' | 'right'
  /** Set on arrival so the receiving surface can animate an entrance; cleared
   *  once that surface acknowledges. */
  enteredFromEdge: PetEdge | null
  updatedAt: number
}

/**
 * A surface that has not checked in for this long is treated as gone, and the
 * pet is moved off it. Without this the pet would be stranded on a phone that
 * went into a pocket — invisible and unreachable on every other screen.
 */
export const SURFACE_STALE_AFTER_MS = 30_000

/**
 * A surface must have checked in this recently to be a valid handoff TARGET.
 *
 * Deliberately much stricter than SURFACE_STALE_AFTER_MS, because eviction and
 * target-eligibility are different questions that used to share one threshold.
 * A killed app never gets to call removeSurface, so its surface stays evictable-
 * but-not-yet-evicted for a full stale window — and the pet would happily walk
 * onto that corpse, where nothing can draw it.
 *
 * Observed 2026-07-21: with a single real phone surface the pet still recorded a
 * handoff (enteredFromEdge 'left', x 0) — it had crossed to its own dead
 * predecessor. The operator saw the pet flicker in and out on the phone and sit
 * frozen on the desktop, both because `holdsPet` was oscillating between a live
 * surface and a zombie, restarting the roam loop before it could travel.
 *
 * ~2.5 heartbeats (8s each) tolerates one dropped beat without letting a dead
 * surface look alive.
 */
export const HANDOFF_TARGET_MAX_AGE_MS = 20_000

/** Stricter liveness used only when choosing where the pet may GO. */
export function isSurfaceHandoffEligible(surface: PetSurface, now: number): boolean {
  return now - surface.seenAt < HANDOFF_TARGET_MAX_AGE_MS
}

/**
 * Can this surface draw this particular pet?
 *
 * A null roster means "anything" (desktop surfaces load sprites from disk). A
 * null petId means nothing has claimed an identity yet, which no surface should
 * be blocked on.
 *
 * The deliberate consequence: a custom pet that was never bundled into the
 * phone simply does not cross to the phone. It stays on the desktop rather than
 * arriving as a different creature. Silent substitution is the bug, not the
 * fallback.
 */
export function canSurfaceRenderPet(surface: PetSurface, petId: string | null): boolean {
  if (petId === null || surface.renderablePetIds === null) {
    return true
  }
  return surface.renderablePetIds.includes(petId)
}

/**
 * Record which pet the operator has selected. Called by whichever surface owns
 * that selection (the desktop); phones mirror it and never write it.
 *
 * Returns the presence by identity when unchanged, so the authority's commit
 * check stays an exact comparison rather than a deep diff.
 */
export function applyPetIdentity(
  presence: PetPresence,
  petId: string,
  now: number
): PetPresence {
  if (presence.petId === petId) {
    return presence
  }
  return { ...presence, petId, updatedAt: now }
}

/** Order handoff destinations are considered in. Earlier kinds win, so a pet
 *  leaving a desktop window prefers a popout on the same machine over a phone
 *  in another room — the nearer screen is the likelier intent. */
const HANDOFF_PREFERENCE: PetSurfaceKind[] = ['desktop-window', 'popout-window', 'phone']

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5
  }
  return Math.min(1, Math.max(0, value))
}

export function oppositeEdge(edge: PetEdge): PetEdge {
  switch (edge) {
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
  }
}

export function isSurfaceAlive(surface: PetSurface, now: number): boolean {
  return now - surface.seenAt < SURFACE_STALE_AFTER_MS
}

/**
 * Where the pet lands when it exits `edge`. It enters on the OPPOSITE edge —
 * leaving rightwards means arriving from the left — and keeps its position on
 * the perpendicular axis so the crossing reads as continuous motion rather
 * than a teleport to a corner.
 */
export function entryPointFor(exitEdge: PetEdge, exitPosition: PetPoint): PetPoint {
  const x = clamp01(exitPosition.x)
  const y = clamp01(exitPosition.y)
  switch (exitEdge) {
    case 'right':
      return { x: 0, y }
    case 'left':
      return { x: 1, y }
    case 'bottom':
      return { x, y: 0 }
    case 'top':
      return { x, y: 1 }
  }
}

/** Facing after entering through `edge` — always inward, away from the wall it
 *  came through. Vertical crossings keep the previous facing since entering
 *  from the top says nothing about left/right. */
export function facingAfterEntry(
  entryEdge: PetEdge,
  previousFacing: PetPresence['facing']
): PetPresence['facing'] {
  if (entryEdge === 'left') {
    return 'right'
  }
  if (entryEdge === 'right') {
    return 'left'
  }
  return previousFacing
}

/**
 * Pick the surface a pet leaving `fromSurfaceId` should land on. Returns null
 * when there is nowhere to go, which is the signal to CLAMP instead of exit —
 * a pet with no destination must stay put rather than vanish.
 */
export function pickHandoffTarget(
  surfaces: PetSurface[],
  fromSurfaceId: string,
  now: number,
  petId: string | null = null
): PetSurface | null {
  const candidates = surfaces.filter(
    (surface) =>
      surface.id !== fromSurfaceId &&
      isSurfaceHandoffEligible(surface, now) &&
      canSurfaceRenderPet(surface, petId)
  )
  if (candidates.length === 0) {
    return null
  }
  const ranked = [...candidates].sort((a, b) => {
    const byKind = HANDOFF_PREFERENCE.indexOf(a.kind) - HANDOFF_PREFERENCE.indexOf(b.kind)
    if (byKind !== 0) {
      return byKind
    }
    // Why most-recently-seen: among equals, the screen the operator is actually
    // using is the one checking in most often.
    return b.seenAt - a.seenAt
  })
  return ranked[0] ?? null
}

export function initialPresence(now: number): PetPresence {
  return {
    surfaceId: null,
    petId: null,
    position: { x: 0.5, y: 0.5 },
    facing: 'right',
    enteredFromEdge: null,
    updatedAt: now
  }
}

/**
 * Apply an edge exit reported by the surface that currently holds the pet.
 *
 * Returns the presence UNCHANGED when the reporting surface is not the holder.
 * That guard is the core of exclusivity: a stale renderer replaying an old exit
 * must never be able to move a pet it does not have.
 */
export function applyEdgeExit(
  presence: PetPresence,
  surfaces: PetSurface[],
  input: { fromSurfaceId: string; edge: PetEdge; position: PetPoint; now: number }
): PetPresence {
  const { fromSurfaceId, edge, position, now } = input
  if (presence.surfaceId !== fromSurfaceId) {
    return presence
  }
  const target = pickHandoffTarget(surfaces, fromSurfaceId, now, presence.petId)
  if (!target) {
    return presence
  }
  const entryEdge = oppositeEdge(edge)
  return {
    ...presence,
    surfaceId: target.id,
    position: entryPointFor(edge, position),
    facing: facingAfterEntry(entryEdge, presence.facing),
    enteredFromEdge: entryEdge,
    updatedAt: now
  }
}

/** Clears the arrival marker once the receiving surface has played its entrance,
 *  so a later re-read does not replay the animation. */
export function acknowledgeEntry(
  presence: PetPresence,
  surfaceId: string,
  now: number
): PetPresence {
  if (presence.surfaceId !== surfaceId || presence.enteredFromEdge === null) {
    return presence
  }
  return { ...presence, enteredFromEdge: null, updatedAt: now }
}

/**
 * Move the pet off any surface that has gone stale, and adopt a surface when
 * the pet has no home at all (first boot, or everything died and something came
 * back). Called on a timer by the authority.
 *
 * Position is deliberately preserved rather than reset: a pet whose window was
 * closed should reappear roughly where it was, not snap to the middle.
 */
export function reconcileSurfaces(
  presence: PetPresence,
  surfaces: PetSurface[],
  now: number
): PetPresence {
  const alive = surfaces.filter((surface) => isSurfaceAlive(surface, now))
  if (alive.length === 0) {
    // Why keep surfaceId: the holder may simply be a laptop that slept. Holding
    // the assignment lets it resume without the pet jumping elsewhere first.
    return presence
  }
  const holderAlive =
    presence.surfaceId !== null && alive.some((surface) => surface.id === presence.surfaceId)
  if (holderAlive) {
    return presence
  }
  const ranked = [...alive].sort(
    (a, b) =>
      HANDOFF_PREFERENCE.indexOf(a.kind) - HANDOFF_PREFERENCE.indexOf(b.kind) ||
      b.seenAt - a.seenAt
  )
  // Prefer a surface that can actually draw this pet, but fall back to any live
  // surface rather than stranding it. Recovery differs from handoff here on
  // purpose: refusing to hand off leaves the pet somewhere visible, whereas
  // refusing to adopt would leave it nowhere at all.
  const adopted =
    ranked.find((surface) => canSurfaceRenderPet(surface, presence.petId)) ?? ranked[0] ?? null
  if (!adopted) {
    return presence
  }
  return {
    ...presence,
    surfaceId: adopted.id,
    position: {
      x: clamp01(presence.position.x),
      y: clamp01(presence.position.y)
    },
    // Why no entry animation: this is a recovery, not a walk. Animating an
    // entrance would imply the pet travelled somewhere it never went.
    enteredFromEdge: null,
    updatedAt: now
  }
}

/** True when `surfaceId` should be drawing the pet right now. */
export function surfaceHoldsPet(presence: PetPresence, surfaceId: string): boolean {
  return presence.surfaceId === surfaceId
}
