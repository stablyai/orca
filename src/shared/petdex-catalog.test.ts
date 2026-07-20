import { describe, expect, it } from 'vitest'
import {
  isPetdexAllowedUrl,
  labelForStarterSlug,
  PETDEX_DEFAULT_ACTIVE_SLUG,
  PETDEX_STARTER_LABELS,
  PETDEX_STARTER_SLUGS,
  selectStarterEntries,
  type PetdexManifest
} from './petdex-catalog'

describe('petdex-catalog', () => {
  it('ships a fixed mesh default pack (operator-curated)', () => {
    expect(PETDEX_STARTER_SLUGS.length).toBe(12)
    expect(new Set(PETDEX_STARTER_SLUGS).size).toBe(12)
    expect(PETDEX_DEFAULT_ACTIVE_SLUG).toBe('mini-gandalf-the-grey')
    expect(PETDEX_STARTER_SLUGS).toContain(PETDEX_DEFAULT_ACTIVE_SLUG)
    for (const slug of PETDEX_STARTER_SLUGS) {
      expect(PETDEX_STARTER_LABELS[slug]).toBeTruthy()
    }
  })

  it('uses preferred labels for claw-crawler / apupepe', () => {
    expect(labelForStarterSlug('claw-crawler')).toBe('kuro-chan')
    expect(labelForStarterSlug('apupepe')).toBe('Pepe')
  })

  it('only allows https petdex hosts', () => {
    expect(isPetdexAllowedUrl('https://assets.petdex.dev/pets/x/sprite.webp')).toBe(true)
    expect(isPetdexAllowedUrl('https://evil.example/sprite.webp')).toBe(false)
  })

  it('selectStarterEntries preserves order and applies labels', () => {
    const manifest: PetdexManifest = {
      pets: [
        {
          slug: 'gojo',
          displayName: 'Gojo Satoru',
          spritesheetUrl: 'https://assets.petdex.dev/pets/gojo/sprite.webp'
        },
        {
          slug: 'nous-girl',
          displayName: 'Nous Girl',
          spritesheetUrl: 'https://assets.petdex.dev/pets/nous/sprite.webp'
        }
      ]
    }
    const selected = selectStarterEntries(manifest, ['nous-girl', 'missing', 'gojo'])
    expect(selected.map((p) => p.slug)).toEqual(['nous-girl', 'gojo'])
    expect(selected[0].displayName).toBe('Nous Girl')
    expect(selected[1].displayName).toBe('Gojo')
  })
})
