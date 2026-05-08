import claudeUrl from '../../../../../resources/claude.webp?url'
import opencodeUrl from '../../../../../resources/opencode.webp?url'
import gremlinUrl from '../../../../../resources/gremlin.webp?url'

// Why: bundled defaults so the overlay always has something to render when the
// user hasn't uploaded a custom image. Vite's `?url` import hashes each asset
// at build time so they participate in the normal caching pipeline.
export const DEFAULT_PET_ID = 'claude-the-mage'
export const OPENCODE_PET_ID = 'opencode-the-rogue'
export const GREMLIN_PET_ID = 'gremlin-the-trickster'

export type BundledPetId = typeof DEFAULT_PET_ID | typeof OPENCODE_PET_ID | typeof GREMLIN_PET_ID

export type BundledPet = {
  id: BundledPetId
  label: string
  url: string
}

export const BUNDLED_PETS: readonly BundledPet[] = [
  {
    id: DEFAULT_PET_ID,
    label: 'Claudino',
    url: claudeUrl
  },
  {
    id: OPENCODE_PET_ID,
    label: 'OpenCode',
    url: opencodeUrl
  },
  {
    id: GREMLIN_PET_ID,
    label: 'Gremlin',
    url: gremlinUrl
  }
] as const

export const BUNDLED_PET: BundledPet = BUNDLED_PETS[0]

export function isBundledPetId(id: string | undefined): boolean {
  return BUNDLED_PETS.some((s) => s.id === id)
}

export function findBundledPet(id: string | undefined): BundledPet | undefined {
  return BUNDLED_PETS.find((s) => s.id === id)
}
