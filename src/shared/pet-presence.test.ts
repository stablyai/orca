import { describe, expect, it } from 'vitest'
import {
  acknowledgeEntry,
  applyEdgeExit,
  applyPetIdentity,
  edgeAtNormalized,
  entryPointFor,
  facingAfterEntry,
  initialPresence,
  isSurfaceAlive,
  oppositeEdge,
  pickHandoffTarget,
  reconcileSurfaces,
  surfaceHoldsPet,
  SURFACE_STALE_AFTER_MS,
  HANDOFF_TARGET_MAX_AGE_MS,
  EDGE_THRESHOLD,
  EDGE_ENTRY_INSET,
  type PetEdge,
  type PetPoint,
  type PetPresence,
  type PetSurface
} from './pet-presence'

const NOW = 1_700_000_000_000

function surface(
  id: string,
  kind: PetSurface['kind'],
  seenAt = NOW,
  renderablePetIds: string[] | null = null
): PetSurface {
  return { id, kind, seenAt, renderablePetIds }
}

describe('edge geometry', () => {
  it('enters through the opposite edge', () => {
    expect(oppositeEdge('right')).toBe('left')
    expect(oppositeEdge('top')).toBe('bottom')
  })

  it('keeps the perpendicular axis so a crossing reads as continuous motion', () => {
    const fromRight = entryPointFor('right', { x: 1, y: 0.23 })
    expect(fromRight.x).toBeCloseTo(EDGE_ENTRY_INSET)
    expect(fromRight.y).toBeCloseTo(0.23)

    const fromBottom = entryPointFor('bottom', { x: 0.77, y: 1 })
    expect(fromBottom.x).toBeCloseTo(0.77)
    expect(fromBottom.y).toBeCloseTo(EDGE_ENTRY_INSET)
  })

  it('clamps a position reported outside the surface', () => {
    const overshoot = entryPointFor('right', { x: 5, y: 9 })
    expect(overshoot.x).toBeCloseTo(EDGE_ENTRY_INSET)
    expect(overshoot.y).toBeCloseTo(1 - EDGE_ENTRY_INSET)

    const nonsense = entryPointFor('left', { x: -3, y: Number.NaN })
    expect(nonsense.x).toBeCloseTo(1 - EDGE_ENTRY_INSET)
    expect(nonsense.y).toBeCloseTo(0.5)
  })

  // The flicker regression, stated as the invariant it violated. An arrival that
  // satisfies edgeAtNormalized makes the receiving surface report an exit on its
  // first frame, and the pet ping-pongs between surfaces at RPC speed.
  it('never lands an arriving pet on an edge — including out of a corner', () => {
    const edges: PetEdge[] = ['left', 'right', 'top', 'bottom']
    const corners: PetPoint[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0.5, y: 0.5 }
    ]
    for (const edge of edges) {
      for (const corner of corners) {
        expect(edgeAtNormalized(entryPointFor(edge, corner))).toBeNull()
      }
    }
  })

  it('insets by more than it considers an edge, or the two rules contradict', () => {
    expect(EDGE_ENTRY_INSET).toBeGreaterThan(EDGE_THRESHOLD)
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

  it('refuses to hand the pet to a surface that has stopped heartbeating', () => {
    // A killed app never calls removeSurface, so its surface is still within the
    // 30s eviction window. The pet must not walk onto that corpse — nothing can
    // draw it there, and holdsPet oscillates as it is evicted and re-adopted.
    const zombie = surface('dead-phone', 'phone', NOW - (HANDOFF_TARGET_MAX_AGE_MS + 1))
    expect(isSurfaceAlive(zombie, NOW)).toBe(true)
    expect(pickHandoffTarget([surface('desk', 'desktop-window'), zombie], 'desk', NOW)).toBeNull()
  })

  it('still hands off to a surface that merely missed a beat', () => {
    const laggy = surface('phone', 'phone', NOW - 9_000)
    expect(pickHandoffTarget([surface('desk', 'desktop-window'), laggy], 'desk', NOW)?.id).toBe(
      'phone'
    )
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

    // And back out again: a popout is a real destination, not a dead end. The
    // ack is required, not incidental — a pet may not walk out of a surface it
    // has not finished walking into.
    const settled = acknowledgeEntry(toPopout, 'pop', NOW + 2)
    const backToDesk = applyEdgeExit(settled, surfaces, {
      fromSurfaceId: 'pop',
      edge: 'left',
      position: { x: 0, y: 0.3 },
      now: NOW + 3
    })
    expect(backToDesk.surfaceId).toBe('desk')
    expect(backToDesk.position.x).toBeCloseTo(1 - EDGE_ENTRY_INSET)
    expect(backToDesk.position.y).toBeCloseTo(0.3)
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
    expect(next.position.x).toBeCloseTo(EDGE_ENTRY_INSET)
    expect(next.position.y).toBeCloseTo(0.4)
    expect(next.enteredFromEdge).toBe('left')
    expect(next.facing).toBe('right')
  })

  it('refuses an exit reported before the arrival was acknowledged', () => {
    // The flicker loop in one assertion: the receiving surface sees the pet at
    // its entry position and reports an exit on the same frame. Honouring that
    // bounces the pet straight back and the two surfaces trade it forever.
    const arriving = applyEdgeExit({ ...initialPresence(NOW), surfaceId: 'desk' }, surfaces, {
      fromSurfaceId: 'desk',
      edge: 'right',
      position: { x: 1, y: 0.4 },
      now: NOW + 1
    })
    expect(arriving.surfaceId).toBe('phone')
    expect(arriving.enteredFromEdge).toBe('left')

    const bounced = applyEdgeExit(arriving, surfaces, {
      fromSurfaceId: 'phone',
      edge: 'left',
      position: { x: 0, y: 0.4 },
      now: NOW + 2
    })
    expect(bounced).toBe(arriving)

    // Once acknowledged, a genuine edge contact is honoured as normal.
    const settled = acknowledgeEntry(arriving, 'phone', NOW + 3)
    const left = applyEdgeExit(settled, surfaces, {
      fromSurfaceId: 'phone',
      edge: 'left',
      position: { x: 0, y: 0.4 },
      now: NOW + 4
    })
    expect(left.surfaceId).toBe('desk')
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

    // The phone finishes arriving before it can leave again.
    presence = acknowledgeEntry(presence, 'phone', NOW + 2)
    presence = applyEdgeExit(presence, surfaces, {
      fromSurfaceId: 'phone',
      edge: 'left',
      position: { x: 0, y: 0.6 },
      now: NOW + 3
    })
    expect(surfaceHoldsPet(presence, 'desk')).toBe(true)
    expect(surfaceHoldsPet(presence, 'phone')).toBe(false)
    expect(presence.position.x).toBeCloseTo(1 - EDGE_ENTRY_INSET)
    expect(presence.position.y).toBeCloseTo(0.6)
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

describe('pet identity travels with the pet (bug 3)', () => {
  it('records the selected pet and no-ops on an unchanged id', () => {
    const presence = initialPresence(NOW)
    const named = applyPetIdentity(presence, 'mini-gandalf-the-grey', NOW + 1)
    expect(named.petId).toBe('mini-gandalf-the-grey')
    // Identity by reference on a repeat: the authority's commit check depends
    // on it, so this is behaviour and not an optimisation detail.
    expect(applyPetIdentity(named, 'mini-gandalf-the-grey', NOW + 2)).toBe(named)
  })

  it('carries identity across a handoff unchanged', () => {
    const presence = {
      ...initialPresence(NOW),
      surfaceId: 'desk',
      petId: 'mini-gandalf-the-grey'
    }
    const next = applyEdgeExit(
      presence,
      [
        surface('desk', 'desktop-window'),
        surface('phone', 'phone', NOW, ['mini-gandalf-the-grey', 'apupepe'])
      ],
      { fromSurfaceId: 'desk', edge: 'right', position: { x: 1, y: 0.5 }, now: NOW + 1 }
    )
    expect(next.surfaceId).toBe('phone')
    // The whole point: a gandalf that walks off the desktop is still a gandalf.
    expect(next.petId).toBe('mini-gandalf-the-grey')
  })

  it('refuses to hand a pet to a surface that cannot draw it', () => {
    // The operator's report: a custom pet arriving on the phone as 'apupepe'.
    // Staying put is correct; silent substitution is the bug.
    const presence = { ...initialPresence(NOW), surfaceId: 'desk', petId: 'custom-wizard' }
    const next = applyEdgeExit(
      presence,
      [surface('desk', 'desktop-window'), surface('phone', 'phone', NOW, ['apupepe'])],
      { fromSurfaceId: 'desk', edge: 'right', position: { x: 1, y: 0.5 }, now: NOW + 1 }
    )
    expect(next).toBe(presence)
  })

  it('still hands over when the phone has the pet bundled', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'desk', petId: 'apupepe' }
    const next = applyEdgeExit(
      presence,
      [surface('desk', 'desktop-window'), surface('phone', 'phone', NOW, ['apupepe'])],
      { fromSurfaceId: 'desk', edge: 'right', position: { x: 1, y: 0.5 }, now: NOW + 1 }
    )
    expect(next.surfaceId).toBe('phone')
  })

  it('a null roster means the surface can draw anything', () => {
    const target = pickHandoffTarget(
      [surface('desk', 'desktop-window'), surface('popout', 'popout-window')],
      'desk',
      NOW,
      'some-custom-pet'
    )
    expect(target?.id).toBe('popout')
  })

  it('adopts a renderable surface over a nearer one that cannot draw the pet', () => {
    // Recovery still prefers correctness, but must never strand the pet.
    const presence = { ...initialPresence(NOW), surfaceId: 'dead', petId: 'custom-wizard' }
    const next = reconcileSurfaces(
      presence,
      [surface('phone', 'phone', NOW, ['apupepe']), surface('desk', 'desktop-window')],
      NOW + 1
    )
    expect(next.surfaceId).toBe('desk')
  })

  it('falls back to any live surface rather than leaving the pet nowhere', () => {
    const presence = { ...initialPresence(NOW), surfaceId: 'dead', petId: 'custom-wizard' }
    const next = reconcileSurfaces(
      presence,
      [surface('phone', 'phone', NOW, ['apupepe'])],
      NOW + 1
    )
    expect(next.surfaceId).toBe('phone')
  })
})
