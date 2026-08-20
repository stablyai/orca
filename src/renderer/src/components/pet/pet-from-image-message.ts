import { translate } from '@/i18n/i18n'
import type { BuildPetFailure } from './pet-from-image'

/** Turns a refusal into advice.
 *
 *  Every cutout failure is recoverable by supplying a different image, so each
 *  message names what went wrong AND what to do about it. "Could not import"
 *  would leave the user with a rejected upload and no idea why. */
export function petBuildFailureMessage(reason: BuildPetFailure): string {
  switch (reason) {
    case 'background-not-separable':
      return translate(
        'auto.components.pet.fromImage.backgroundNotSeparable',
        'The background is too busy to separate from the character. Try a PNG with a transparent background, or a photo on a plain background.'
      )
    case 'subject-not-found':
      return translate(
        'auto.components.pet.fromImage.subjectNotFound',
        'No character was left after removing the background. Try another image, or crop it closer to the character.'
      )
    case 'subject-fragmented':
      return translate(
        'auto.components.pet.fromImage.subjectFragmented',
        'The character came out in scattered pieces rather than one shape. Try an image with a plain background, or one with transparency.'
      )
    case 'full-bleed':
      return translate(
        'auto.components.pet.fromImage.fullBleed',
        'The picture fills every edge, so there is no character to cut out. Crop it around the character and try again.'
      )
    case 'no-character-shape':
      return translate(
        'auto.components.pet.fromImage.noCharacterShape',
        'The character could not be made out against the background. Try a PNG with a transparent background, or crop closer.'
      )
    case 'unknown-style':
      return translate(
        'auto.components.pet.fromImage.unknownStyle',
        'That pet style is not available.'
      )
    case 'style-artwork-unavailable':
      return translate(
        'auto.components.pet.fromImage.styleArtworkUnavailable',
        'That pet’s artwork could not be loaded, so the head cannot be placed on it. Try another style, or the whole body option.'
      )
  }
}
