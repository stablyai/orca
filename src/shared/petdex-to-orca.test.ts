import { describe, expect, it } from 'vitest'
import { CODEX_PET_ANIMATIONS, CODEX_PET_FRAME } from './codex-pet-sprite-defaults'
import {
  buildBundlePetJson,
  buildCodexSpriteMeta,
  buildCustomPetRecord,
  gridFromSheet,
  PetdexConvertError
} from './petdex-to-orca'

describe('petdex-to-orca', () => {
  it('accepts the standard Petdex/Codex 1536×1872 sheet', () => {
    const grid = gridFromSheet({ width: 1536, height: 1872 })
    expect(grid).toEqual({ columns: 8, rows: 9 })
  })

  it('rejects non-multiples of the frame', () => {
    expect(() => gridFromSheet({ width: 1500, height: 1872 })).toThrow(PetdexConvertError)
  })

  it('rejects undersized grids', () => {
    expect(() =>
      gridFromSheet({
        width: CODEX_PET_FRAME.width * 4,
        height: CODEX_PET_FRAME.height * 4
      })
    ).toThrow(/columns/)
  })

  it('bakes full Codex animation map into CustomPet.sprite', () => {
    const sprite = buildCodexSpriteMeta({ width: 1536, height: 1872 })
    expect(sprite.columns).toBe(8)
    expect(sprite.rows).toBe(9)
    expect(sprite.defaultAnimation).toBe('idle')
    expect(Object.keys(sprite.animations ?? {})).toEqual(Object.keys(CODEX_PET_ANIMATIONS))
    expect(sprite.animations?.running?.row).toBe(7)
    expect(sprite.animations?.review?.row).toBe(8)
  })

  it('buildCustomPetRecord produces a bundle-kind index entry', () => {
    const pet = buildCustomPetRecord({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      label: 'Blue Boba Axolotl',
      dims: { width: 1536, height: 1872 }
    })
    expect(pet.kind).toBe('bundle')
    expect(pet.fileName).toBe('spritesheet.webp')
    expect(pet.mimeType).toBe('image/webp')
    expect(pet.sprite?.sheetWidth).toBe(1536)
    expect(pet.label).toBe('Blue Boba Axolotl')
  })

  it('buildBundlePetJson matches Orca importPetBundle expectations', () => {
    const j = buildBundlePetJson({
      slug: 'nous-girl',
      displayName: 'Nous Girl',
      description: 'Mesh mascot'
    })
    expect(j.spritesheetPath).toBe('spritesheet.webp')
    expect(j.id).toBe('nous-girl')
    expect(j.displayName).toBe('Nous Girl')
  })
})
