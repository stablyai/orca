/**
 * Bubble text rules now live in `src/shared/pet-bubble-text.ts` — the phone
 * draws the same pet and must say the same things about the same agents.
 *
 * This file stays as the renderer's entry point so existing imports (and the
 * suite that already covers these rules) are untouched. See pet-drag.ts for the
 * same move, and the slug identity fix for why one definition matters when two
 * surfaces share one creature.
 */
export {
  formatPetBubbleText,
  petBubbleWinnerKey,
  pickPetBubbleLine,
  selectPetBubbleWinner,
  PET_BEAT_MS,
  type PetBubbleAgent,
  type PetBubbleMood,
  type PetBubbleWinner
} from '../../../../shared/pet-bubble-text'
