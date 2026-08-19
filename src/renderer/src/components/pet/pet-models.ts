import claudeUrl from '../../../../../resources/claude.webp?url'
import opencodeUrl from '../../../../../resources/opencode.webp?url'
import gremlinUrl from '../../../../../resources/gremlin.webp?url'
// Held poses: the idle art's own arms, lifted about the shoulder. Static — the
// overlay's sway supplies the motion while the pet dangles.
import claudeHeldUrl from '../../../../../resources/claude-held.webp?url'
import opencodeHeldUrl from '../../../../../resources/opencode-held.webp?url'
import gremlinHeldUrl from '../../../../../resources/gremlin-held.webp?url'
import { translate } from '@/i18n/i18n'
import type { BundledPetWalk } from './bundled-pet-walk-sprite'
// Walk cycles: four frames per strip, the pet's own legs swung about the hip.
import claudeWalkUrl from '../../../../../resources/claude-walk.webp?url'
import opencodeWalkUrl from '../../../../../resources/opencode-walk.webp?url'
import gremlinWalkUrl from '../../../../../resources/gremlin-walk.webp?url'

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
  /** Optional looping walk cycle played while the pet paces the lane. */
  walk?: BundledPetWalk
}

const WALK_FPS = 8
const WALK_FRAMES = 4

export const BUNDLED_PETS: readonly BundledPet[] = [
  {
    id: DEFAULT_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.2528586aa7', 'Claudino')
    },
    url: claudeUrl,
    heldUrl: claudeHeldUrl,
    walk: {
      url: claudeWalkUrl,
      frameWidth: 320,
      frameHeight: 180,
      frames: WALK_FRAMES,
      fps: WALK_FPS
    }
  },
  {
    id: OPENCODE_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.a84d5677ff', 'OpenCode')
    },
    url: opencodeUrl,
    heldUrl: opencodeHeldUrl,
    walk: {
      url: opencodeWalkUrl,
      frameWidth: 252,
      frameHeight: 320,
      frames: WALK_FRAMES,
      fps: WALK_FPS
    }
  },
  {
    id: GREMLIN_PET_ID,
    get label() {
      return translate('auto.components.pet.pet.models.7433516faf', 'Gremlin')
    },
    url: gremlinUrl,
    heldUrl: gremlinHeldUrl,
    walk: {
      url: gremlinWalkUrl,
      frameWidth: 252,
      frameHeight: 320,
      frames: WALK_FRAMES,
      fps: WALK_FPS
    }
  }
] as const

export const BUNDLED_PET: BundledPet = BUNDLED_PETS[0]

export function isBundledPetId(id: string | undefined): boolean {
  return BUNDLED_PETS.some((s) => s.id === id)
}

export function findBundledPet(id: string | undefined): BundledPet | undefined {
  return BUNDLED_PETS.find((s) => s.id === id)
}
