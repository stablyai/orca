import { describe, expect, it } from 'vitest'
import {
  acknowledgeEntry,
  applyEdgeExit,
  entryPointFor,
  facingAfterEntry,
  initialPresence,
  isSurfaceAlive,
  oppositeEdge,
  pickHandoffTarget,
  reconcileSurfaces,
  surfaceHoldsPet,
  SURFACE_STALE_AFTER_MS,
  type PetPresence,
  type PetSurface
} from './pet-presence'

const NOW = 1_700_000_000_000

function surface(id: string, kind: PetSurface['kind'], seenAt = NOW): PetSurface {
  return { id, kind, seenAt }
}

describe('edge geometry', () => {
  it('enters through the opposite edge', () => {
    expect(oppositeEdge('right')).toBe('left')
    expect(oppositeEdge('top')).toBe('bottom')
  })

  it('keeps the perpendicular axis so a crossing reads as continuous motion', () => {
    expect(entryPointFor('right', { x: 1, y: 0.23 })).toEqual({ x: 0, y: 0.23 })
    expect(entryPointFor('bottom', { x: 0.77, y: 1 })).toEqual({ x: 0.77, y: 0 })
  })

  it('clamps a position reported outside the surface', () => {
    expect(entryPointFor('right', { x: 5, y: 9 })).toEqual({ x: 0, y: 1 })
    expect(entryPointFor('left', { x: -3, y: Number.NaN })).toEqual({ x: 1, y: 0.5 })
  })

  it('faces inward after a horizontal entry and keeps facing on a vertical one', () => {
    expect(facingAfterEntry('left', 'left')).toBe('right')
    expect(facingAfterEntry('right', 'right')).toBe('left')
    expect(facingAfterEntry('top', 'left')).toBe('left')
  })
})

describe('surface liveness', () => {
  it('treats a surface as gone once it stops checking in', () => {
    expect(isSurfaceAlive(surface('a', 'phone', NOW - 1000), NOW)).toBe(true)
    expect(isSurfaceAlive(surface('a', 'phone', NOW - SURFACE_STALE_AFTER_MS), NOW)).toBe(false)
  })
})

describe('pickHandoffTarget', () => {
  it('never hands the pet back to the surface it is leaving', () => {
    const target = pickHandoffTarget([surface('desk', 'desktop-window')], 'desk', NOW)
    expect(target).toBeNull()
  })

  it('returns null when every other surface is stale', () => {
    const target = pickHandoffTarget(
      [surface('desk', 'desktop-window'), surface('phone', 'phone', NOW - SURFACE_STALE_AFTER_MS)],
      'desk',
      NOW
    )
    expect(target).toBeNull()
  })

  it('prefers a nearer surface kind over a phone', () => {
    const target = pickHandoffTarget(
      [surface('desk', 'desktop-window'), surface('phone', 'phone'), surface('pop', 'popout-window')],
      'desk',
      NOW
    )
    expect(target?.id).toBe('pop')
  })

  it('lets a pet walk from the main window into a popout (P5)', () => {
    // Why this ordering matters: a popout shares the operator's desk, a phone
    // may be in another room. Reaching the nearer screen first is the likelier
    // intent when both are alive.
    const surfaces = [
      surface('desk', 'desktop-window'),
      surface('pop', 'popout-window'),
      surface('phone', 'phone')
    ]
    const toPopout = applyEdgeExit({ ...initialPresence(NOW), surfaceId: 'desk' }, surfaces, {
      fromSurfaceId: 'desk',
      edge: 'right',
      position: { x: 1, y: 0.3 },
      now: NOW + 1
    })
    expect(toPopout.surfaceId).toBe('pop')

    // And back out again: a popout is a real destination, not a dead end.
    const backToDesk = applyEdgeExit(toPopout, surfaces, {
      fromSurfaceId: 'pop',
      edge: 'left',
      position: { x: 0, y: 0.3 },
      now: NOW + 2
    })
    expect(backToDesk.surfaceId).toBe('desk')
    expect(backToDesk.position).toEqual({ x: 1, y: 0.3 })
  })

  it('breaks ties on most recently seen', () => {
    const target = pickHandoffTarget(
      [
        surface('desk', 'desktop-window'),
        surface('phoneA', 'phone', NOW - 5000),
        surface('phoneB', 'phone', NOW - 100)
      ],
      'desk',
      NOW
    )
    expect(target?.id).toBe('phoneB')
  })
})

describe('applyEdgeExit', () => {
  const surfaces = [surface('desk', 'desktop-window'), surface('phone', 'phone')]

  it('moves the pet to the target and marks the arrival edge', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'desk' }
    const next = applyEdgeExit(presence, surfaces, {
      fromSurfaceId: 'desk',
      edge: 'right',
      position: { x: 1, y: 0.4 },
      now: NOW + 1
    })
    expect(next.surfaceId).toBe('phone')
    expect(next.position).toEqual({ x: 0, y: 0.4 })
    expect(next.enteredFromEdge).toBe('left')
    expect(next.facing).toBe('right')
  })

  it('leaves the pet exactly where it was when there is nowhere to go', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'desk' }
    const next = applyEdgeExit(presence, [surface('desk', 'desktop-window')], {
      fromSurfaceId: 'desk',
      edge: 'right',
      position: { x: 1, y: 0.4 },
      now: NOW + 1
    })
    // Why identity: with no destination the caller must clamp, and an unchanged
    // object makes "nothing happened" unambiguous.
    expect(next).toBe(presence)
  })

  it('ignores an exit reported by a surface that does not hold the pet', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'desk' }
    const next = applyEdgeExit(presence, surfaces, {
      fromSurfaceId: 'phone',
      edge: 'left',
      position: { x: 0, y: 0.5 },
      now: NOW + 1
    })
    expect(next).toBe(presence)
  })

  it('keeps the pet exclusive across a round trip', () => {
    let presence: PetPresence = { ...initialPresence(NOW), surfaceId: 'desk' }
    presence = applyEdgeExit(presence, surfaces, {
      fromSurfaceId: 'desk',
      edge: 'right',
      position: { x: 1, y: 0.6 },
      now: NOW + 1
    })
    expect(surfaceHoldsPet(presence, 'phone')).toBe(true)
    expect(surfaceHoldsPet(presence, 'desk')).toBe(false)

    presence = applyEdgeExit(presence, surfaces, {
      fromSurfaceId: 'phone',
      edge: 'left',
      position: { x: 0, y: 0.6 },
      now: NOW + 2
    })
    expect(surfaceHoldsPet(presence, 'desk')).toBe(true)
    expect(surfaceHoldsPet(presence, 'phone')).toBe(false)
    expect(presence.position).toEqual({ x: 1, y: 0.6 })
  })
})

describe('acknowledgeEntry', () => {
  it('clears the arrival marker so the entrance is not replayed', () => {
    const arrived = applyEdgeExit(
      { ...initialPresence(NOW), surfaceId: 'desk' },
      [surface('desk', 'desktop-window'), surface('phone', 'phone')],
      { fromSurfaceId: 'desk', edge: 'right', position: { x: 1, y: 0.5 }, now: NOW + 1 }
    )
    const acked = acknowledgeEntry(arrived, 'phone', NOW + 2)
    expect(acked.enteredFromEdge).toBeNull()
    expect(acked.surfaceId).toBe('phone')
  })

  it('ignores an acknowledgement from a surface that does not hold the pet', () => {
    const arrived = applyEdgeExit(
      { ...initialPresence(NOW), surfaceId: 'desk' },
      [surface('desk', 'desktop-window'), surface('phone', 'phone')],
      { fromSurfaceId: 'desk', edge: 'right', position: { x: 1, y: 0.5 }, now: NOW + 1 }
    )
    expect(acknowledgeEntry(arrived, 'desk', NOW + 2)).toBe(arrived)
  })
})

describe('reconcileSurfaces', () => {
  it('rescues a pet stranded on a surface that went away', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'phone', position: { x: 0.2, y: 0.8 } }
    const next = reconcileSurfaces(
      presence,
      [surface('desk', 'desktop-window'), surface('phone', 'phone', NOW - SURFACE_STALE_AFTER_MS)],
      NOW
    )
    expect(next.surfaceId).toBe('desk')
    // Why preserved: a closed window should not also teleport the pet to centre.
    expect(next.position).toEqual({ x: 0.2, y: 0.8 })
    expect(next.enteredFromEdge).toBeNull()
  })

  it('adopts a surface when the pet has no home yet', () => {
    const next = reconcileSurfaces(initialPresence(NOW), [surface('phone', 'phone')], NOW)
    expect(next.surfaceId).toBe('phone')
  })

  it('leaves the holder alone while it is alive', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'phone' }
    const next = reconcileSurfaces(
      presence,
      [surface('desk', 'desktop-window'), surface('phone', 'phone')],
      NOW
    )
    expect(next).toBe(presence)
  })

  it('holds the assignment when every surface is asleep rather than reassigning', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'phone' }
    const next = reconcileSurfaces(
      presence,
      [surface('phone', 'phone', NOW - SURFACE_STALE_AFTER_MS)],
      NOW
    )
    expect(next).toBe(presence)
  })
})
