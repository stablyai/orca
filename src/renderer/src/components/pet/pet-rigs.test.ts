import { describe, expect, it } from 'vitest'
import { BUNDLED_PET_RIGS, petRigFor } from './pet-rigs'
import { BUNDLED_PETS } from './pet-models'

describe('BUNDLED_PET_RIGS', () => {
  it('rigs every bundled pet, so none can ship without one', () => {
    for (const pet of BUNDLED_PETS) {
      expect(petRigFor(pet.id), `${pet.id} has no rig`).toBeDefined()
    }
  })

  it('keeps each leg box inside its own frame', () => {
    for (const [id, rig] of Object.entries(BUNDLED_PET_RIGS)) {
      for (const leg of rig.legs) {
        const [x0, y0, x1, y1] = leg.box
        expect(x0, `${id} leg x0`).toBeGreaterThanOrEqual(0)
        expect(y0, `${id} leg y0`).toBeGreaterThanOrEqual(0)
        expect(x1, `${id} leg x1`).toBeLessThanOrEqual(rig.frame.width)
        expect(y1, `${id} leg y1`).toBeLessThanOrEqual(rig.frame.height)
        expect(x1).toBeGreaterThan(x0)
        expect(y1).toBeGreaterThan(y0)
      }
    }
  })

  it('mirrors exactly one leg, so both feet end up facing the same way', () => {
    for (const [id, rig] of Object.entries(BUNDLED_PET_RIGS)) {
      const mirrored = rig.legs.filter((l) => l.mirror).length
      expect(mirrored, `${id} mirrors ${mirrored} legs`).toBe(1)
    }
  })

  it('anchors each head slot above the legs', () => {
    for (const [id, rig] of Object.entries(BUNDLED_PET_RIGS)) {
      const legTop = Math.min(...rig.legs.map((l) => l.box[1]))
      expect(rig.head[3], `${id} head bottom`).toBeLessThanOrEqual(legTop)
    }
  })

  it('returns undefined for an unknown pet rather than guessing one', () => {
    expect(petRigFor('not-a-pet')).toBeUndefined()
  })
})
