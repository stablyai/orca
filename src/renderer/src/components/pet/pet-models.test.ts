import { describe, expect, it } from 'vitest'
import { BUNDLED_PETS } from './pet-models'

describe('BUNDLED_PETS', () => {
  it('ships a distinct held pose for every bundled pet', () => {
    for (const pet of BUNDLED_PETS) {
      expect(pet.heldUrl, `${pet.id} has no held pose`).toBeTruthy()
      expect(pet.heldUrl).not.toBe(pet.url)
    }
  })
})
