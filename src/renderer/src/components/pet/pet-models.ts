import claudeUrl from '../../../../../resources/claude.webp?url'
import opencodeUrl from '../../../../../resources/opencode.webp?url'
import gremlinUrl from '../../../../../resources/gremlin.webp?url'
import { translate } from '@/i18n/i18n'
import {
  DEFAULT_PET_ID,
  GREMLIN_PET_ID,
  OPENCODE_PET_ID,
  isBundledPetId,
  type BundledPetId
} from '../../../../shared/pet-types'

export { DEFAULT_PET_ID, OPENCODE_PET_ID, GREMLIN_PET_ID, isBundledPetId, type BundledPetId }

// Why: bundled defaults so the overlay always has something to render when the
// user hasn't uploaded a custom image. Vite's `?url` import hashes each asset
// at build time so they participate in the normal caching pipeline.

export type BundledPet = {
  id: BundledPetId
  label: string
  url: string
}

export const BUNDLED_PETS: readonly BundledPet[] = [
  {
    id: DEFAULT_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.2528586aa7', 'Claudino')
    },
    url: claudeUrl
  },
  {
    id: OPENCODE_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.a84d5677ff', 'OpenCode')
    },
    url: opencodeUrl
  },
  {
    id: GREMLIN_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.7433516faf', 'Gremlin')
    },
    url: gremlinUrl
  }
] as const

export const BUNDLED_PET: BundledPet = BUNDLED_PETS[0]

export function findBundledPet(id: string | undefined): BundledPet | undefined {
  return BUNDLED_PETS.find((s) => s.id === id)
}
