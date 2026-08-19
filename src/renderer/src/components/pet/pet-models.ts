import claudeUrl from '../../../../../resources/claude.webp?url'
import opencodeUrl from '../../../../../resources/opencode.webp?url'
import gremlinUrl from '../../../../../resources/gremlin.webp?url'
// Held poses: the idle art's own arms, lifted about the shoulder. Static — the
// overlay's sway supplies the motion while the pet dangles.
import claudeHeldUrl from '../../../../../resources/claude-held.webp?url'
import opencodeHeldUrl from '../../../../../resources/opencode-held.webp?url'
import gremlinHeldUrl from '../../../../../resources/gremlin-held.webp?url'
import { translate } from '@/i18n/i18n'

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
  /** Optional "held in hand" artwork shown while the pet is being dragged. */
  heldUrl?: string
}

export const BUNDLED_PETS: readonly BundledPet[] = [
  {
    id: DEFAULT_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.2528586aa7', 'Claudino')
    },
    url: claudeUrl,
    heldUrl: claudeHeldUrl
  },
  {
    id: OPENCODE_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.a84d5677ff', 'OpenCode')
    },
    url: opencodeUrl,
    heldUrl: opencodeHeldUrl
  },
  {
    id: GREMLIN_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.7433516faf', 'Gremlin')
    },
    url: gremlinUrl,
    heldUrl: gremlinHeldUrl
  }
] as const

export const BUNDLED_PET: BundledPet = BUNDLED_PETS[0]

export function isBundledPetId(id: string | undefined): boolean {
  return BUNDLED_PETS.some((s) => s.id === id)
}

export function findBundledPet(id: string | undefined): BundledPet | undefined {
  return BUNDLED_PETS.find((s) => s.id === id)
}
