import { MARINE_CREATURE_NAMES_PRIMARY } from './marine-creature-names-primary'
import { MARINE_CREATURE_NAMES_SECONDARY } from './marine-creature-names-secondary'

// Why: the auto-generated workspace name pool lives in shared (not renderer)
// so the main process can recognize an Orca-generated branch name when deciding
// whether auto-rename-from-work is allowed to overwrite it.
export const MARINE_CREATURES = [
  ...MARINE_CREATURE_NAMES_PRIMARY,
  ...MARINE_CREATURE_NAMES_SECONDARY
] as const
