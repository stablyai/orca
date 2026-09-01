import type { CSSProperties } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  normalizeAppBackgroundImage,
  normalizeAppBackgroundImageFit,
  normalizeAppBackgroundImageOpacity,
  type AppBackgroundImageFit
} from '../../../shared/app-background-image'

type AppBackgroundImageSettings = Pick<
  GlobalSettings,
  'appBackgroundImage' | 'appBackgroundImageOpacity' | 'appBackgroundImageFit'
>

const FIT_BACKGROUND_SIZE: Record<AppBackgroundImageFit, string> = {
  cover: 'cover',
  contain: 'contain',
  stretch: '100% 100%',
  center: 'auto'
}

/** Undefined (render nothing) unless a valid background image is configured. */
export function resolveAppBackgroundImageStyle(
  settings: AppBackgroundImageSettings | null | undefined
): CSSProperties | undefined {
  const image = normalizeAppBackgroundImage(settings?.appBackgroundImage)
  if (!image) {
    return undefined
  }
  const fit = normalizeAppBackgroundImageFit(settings?.appBackgroundImageFit)
  return {
    backgroundImage: `url("${image}")`,
    backgroundSize: FIT_BACKGROUND_SIZE[fit],
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    opacity: normalizeAppBackgroundImageOpacity(settings?.appBackgroundImageOpacity)
  }
}
