import { MARINE_CREATURE_NAMES_PRIMARY } from './marine-creature-names-primary'
import { MARINE_CREATURE_NAMES_SECONDARY } from './marine-creature-names-secondary'

// Main recognizes generated branch names before auto-renaming from work, so keep the name pool outside renderer.
export const MARINE_CREATURES = [
  ...MARINE_CREATURE_NAMES_PRIMARY,
  ...MARINE_CREATURE_NAMES_SECONDARY
] as const
