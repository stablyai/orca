import { describe, expect, it } from 'vitest'
import {
  isPetdexAllowedUrl,
  PETDEX_STARTER_SLUGS,
  selectStarterEntries,
  type PetdexManifest
} from './petdex-catalog'

describe('petdex-catalog', () => {
  it('pins starter pack to a non-empty intentional list', () => {
    expect(PETDEX_STARTER_SLUGS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(PETDEX_STARTER_SLUGS).size).toBe(PETDEX_STARTER_SLUGS.length)
  })

  it('only allows https petdex hosts', () => {
    expect(isPetdexAllowedUrl('https://assets.petdex.dev/pets/x/sprite.webp')).toBe(true)
    expect(isPetdexAllowedUrl('https://petdex.dev/api/manifest')).toBe(true)
    expect(isPetdexAllowedUrl('http://assets.petdex.dev/pets/x/sprite.webp')).toBe(false)
    expect(isPetdexAllowedUrl('https://evil.example/sprite.webp')).toBe(false)
    expect(isPetdexAllowedUrl('not-a-url')).toBe(false)
  })

  it('selectStarterEntries preserves order and drops missing/disallowed', () => {
    const manifest: PetdexManifest = {
      pets: [
        {
          slug: 'nous-girl',
          displayName: 'Nous Girl',
          spritesheetUrl: 'https://assets.petdex.dev/pets/nous-girl/sprite.webp'
        },
        {
          slug: 'evil',
          displayName: 'Evil',
          spritesheetUrl: 'https://evil.example/s.webp'
        },
        {
          slug: 'blue-boba-axolotl',
          displayName: 'Blue Boba Axolotl',
          spritesheetUrl: 'https://assets.petdex.dev/pets/blue-boba/sprite.webp'
        }
      ]
    }
    const selected = selectStarterEntries(manifest, [
      'blue-boba-axolotl',
      'missing-slug',
      'evil',
      'nous-girl'
    ])
    expect(selected.map((p) => p.slug)).toEqual(['blue-boba-axolotl', 'nous-girl'])
  })
})
