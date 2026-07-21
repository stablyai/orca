/**
 * Pure decision/step helpers for the Orca pet's in-window wander.
 *
 * Hermes desktop roam is a full platformer (ledges, hop, RAF DOM writes).
 * Here we only need: pick a viewport target, step toward it, clamp, and
 * pause while the agent is busy or the operator is dragging the pet.
 *
 * Lives in shared/ so the desktop renderer and the phone run the SAME motion.
 * Two implementations would drift, and a pet that strolls differently either
 * side of a handoff stops reading as one creature.
 */

import type { AgentStatusEntry } from './agent-status-types'

// Inlined rather than imported from the renderer: this module is shared with
// React Native (the phone runs the identical roam so the pet moves the same way
// on every surface), and mobile cannot reach renderer-only modules. The rule is
// one comparison; duplicating it is cheaper than exporting a renderer barrel
// into the mobile bundle. Mirrors lib/pane-agent-evidence.isExplicitAgentStatusFresh.
function isExplicitAgentStatusFresh(
  entry: Pick<AgentStatusEntry, 'updatedAt'>,
  now: number,
  staleAfterMs: number
): boolean {
  return now - entry.updatedAt <= staleAfterMs
}

export type Rng = () => number

export type Position = { x: number; y: number }

export type Viewport = { width: number; height: number }

/** Keep the pet square fully inside the viewport (shared with PetOverlay). */
export function clampPositionToViewport(
  pos: Position,
  size: number,
  viewport: Viewport
): Position {
  const maxX = Math.max(0, viewport.width - size)
  const maxY = Math.max(0, viewport.height - size)
  return {
    x: Math.min(Math.max(0, pos.x), maxX),
    y: Math.min(Math.max(0, pos.y), maxY)
  }
}

/** Default dwell between stroll targets (ms). */
export const ROAM_DWELL_MS = 2800

/** Horizontal/vertical wander speed in CSS pixels per millisecond. */
export const ROAM_SPEED_PX_PER_MS = 0.06

/** Minimum distance a stroll must cover (px) so the pet actually moves. */
export const ROAM_MIN_STROLL_PX = 48

export type RoamPauseInput = {
  dragging: boolean
  agentBusy: boolean
}

/** Roam is off while the user is dragging or any agent is actively busy. */
export function isRoamPaused({ dragging, agentBusy }: RoamPauseInput): boolean {
  return dragging || agentBusy
}

/**
 * Busy = a fresh working/blocked/waiting entry. Done/idle/review do not pause
 * roam — the pet can loaf around while the operator reads a finished pane.
 */
export function isAgentBusyForRoam(
  entries: readonly AgentStatusEntry[],
  now: number,
  staleAfterMs: number
): boolean {
  for (const entry of entries) {
    if (!isExplicitAgentStatusFresh(entry, now, staleAfterMs)) {
      continue
    }
    if (entry.state === 'working' || entry.state === 'blocked' || entry.state === 'waiting') {
      return true
    }
  }
  return false
}

/**
 * Pick a new top-left position for the pet square, clamped so the full size
 * stays in the viewport. Biases away from the current spot so the step is
 * visible (at least ROAM_MIN_STROLL_PX when the room allows).
 */
export function pickRoamTarget(
  from: Position,
  size: number,
  viewport: Viewport,
  rng: Rng = Math.random
): Position {
  const maxX = Math.max(0, viewport.width - size)
  const maxY = Math.max(0, viewport.height - size)
  if (maxX === 0 && maxY === 0) {
    return clampPositionToViewport(from, size, viewport)
  }

  // Try a few random corners of the room; accept first that travels far enough.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = clampPositionToViewport(
      {
        x: rng() * maxX,
        y: rng() * maxY
      },
      size,
      viewport
    )
    const dx = candidate.x - from.x
    const dy = candidate.y - from.y
    if (Math.hypot(dx, dy) >= ROAM_MIN_STROLL_PX) {
      return candidate
    }
  }

  // Fallback: step toward the opposite corner of the free rect.
  const toward: Position = {
    x: from.x < maxX / 2 ? maxX : 0,
    y: from.y < maxY / 2 ? maxY : 0
  }
  return clampPositionToViewport(toward, size, viewport)
}

/**
 * Advance `from` toward `target` by at most speed*dt pixels. Returns the new
 * position (already clamped) and whether the stroll has arrived.
 */
export function stepRoamPosition(
  from: Position,
  target: Position,
  size: number,
  viewport: Viewport,
  dtMs: number,
  speedPxPerMs: number = ROAM_SPEED_PX_PER_MS
): { position: Position; arrived: boolean } {
  const dx = target.x - from.x
  const dy = target.y - from.y
  const dist = Math.hypot(dx, dy)
  const step = Math.max(0, speedPxPerMs) * Math.max(0, dtMs)
  if (dist <= step || dist < 0.5) {
    const position = clampPositionToViewport(target, size, viewport)
    return { position, arrived: true }
  }
  const t = step / dist
  const position = clampPositionToViewport(
    {
      x: from.x + dx * t,
      y: from.y + dy * t
    },
    size,
    viewport
  )
  return { position, arrived: false }
}

/**
 * One pure roam tick: if paused, freeze; if no target or arrived, pick a new
 * one; otherwise step. All position math stays in pure functions for tests.
 */
export function tickRoam(args: {
  position: Position
  target: Position | null
  size: number
  viewport: Viewport
  dtMs: number
  paused: boolean
  rng?: Rng
  speedPxPerMs?: number
}): { position: Position; target: Position | null } {
  const {
    position,
    size,
    viewport,
    dtMs,
    paused,
    rng = Math.random,
    speedPxPerMs = ROAM_SPEED_PX_PER_MS
  } = args
  if (paused) {
    return { position, target: args.target }
  }
  let target = args.target
  if (!target) {
    target = pickRoamTarget(position, size, viewport, rng)
  }
  const stepped = stepRoamPosition(position, target, size, viewport, dtMs, speedPxPerMs)
  if (stepped.arrived) {
    return { position: stepped.position, target: null }
  }
  return { position: stepped.position, target }
}
