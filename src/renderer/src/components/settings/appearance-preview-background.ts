import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { OrcaBackgroundFit } from '../../../../shared/orca-background-settings'
import {
  browserBackgroundImageObjectUrls,
  type BackgroundImageObjectUrlApi
} from '../../lib/background-image-object-url'
import {
  resolveAppearanceBackground,
  type AppearanceBackgroundArea
} from '../../lib/appearance-background-settings'

export type { AppearanceBackgroundArea } from '../../lib/appearance-background-settings'

type BackgroundImageLoadResult =
  | { ok: true; data: Uint8Array; mimeType: string }
  | { ok: false; reason: string }

type BackgroundImageApi = {
  loadImage: (fileName: string) => Promise<BackgroundImageLoadResult>
}

export type AppearancePreviewBackground = {
  area: AppearanceBackgroundArea
  fileName: string
  opacity: number
  blurPx: number
  fit: OrcaBackgroundFit
}

export type LoadedAppearancePreviewBackground = AppearancePreviewBackground & {
  objectUrl: string
}

const BACKGROUND_FITS: Record<
  OrcaBackgroundFit,
  Pick<CSSProperties, 'backgroundRepeat' | 'backgroundSize'>
> = {
  cover: { backgroundSize: 'cover', backgroundRepeat: 'no-repeat' },
  contain: { backgroundSize: 'contain', backgroundRepeat: 'no-repeat' },
  stretch: { backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat' },
  tile: { backgroundSize: 'auto', backgroundRepeat: 'repeat' }
}

function getBackgroundImageApi(): BackgroundImageApi | null {
  if (typeof window === 'undefined') {
    return null
  }
  const backgrounds = (
    window as Window & {
      api?: { backgrounds?: BackgroundImageApi }
    }
  ).api?.backgrounds
  return backgrounds && typeof backgrounds.loadImage === 'function' ? backgrounds : null
}

export function resolveAppearancePreviewBackground(
  settings: GlobalSettings,
  area: AppearanceBackgroundArea
): AppearancePreviewBackground | null {
  const background = resolveAppearanceBackground(settings, area)
  if (!background.active || !background.imageName) {
    return null
  }

  return {
    area,
    fileName: background.imageName,
    opacity: background.opacity,
    blurPx: background.blurPx,
    fit: background.fit
  }
}

export async function createAppearancePreviewBackgroundObjectUrl(
  fileName: string,
  api: BackgroundImageApi | null = getBackgroundImageApi(),
  backgroundObjectUrls: BackgroundImageObjectUrlApi = browserBackgroundImageObjectUrls
): Promise<string | null> {
  if (!api) {
    return null
  }
  try {
    const result = await api.loadImage(fileName)
    if (!result.ok) {
      return null
    }
    return backgroundObjectUrls.create(result.data, result.mimeType)
  } catch {
    return null
  }
}

export function getAppearancePreviewBackgroundStyle(
  background: LoadedAppearancePreviewBackground
): CSSProperties {
  return {
    backgroundImage: `url("${background.objectUrl}")`,
    backgroundPosition: 'center center',
    ...BACKGROUND_FITS[background.fit],
    opacity: background.opacity,
    filter: `blur(${background.blurPx}px)`,
    transform: `scale(${Math.min(2, 1 + background.blurPx / 25)})`,
    transformOrigin: 'center center'
  }
}

export function useAppearancePreviewBackground(
  settings: GlobalSettings,
  area: AppearanceBackgroundArea,
  dependencies: {
    imageApi?: BackgroundImageApi | null
    backgroundObjectUrls?: BackgroundImageObjectUrlApi
  } = {}
): LoadedAppearancePreviewBackground | null {
  const background = useMemo(
    () => resolveAppearancePreviewBackground(settings, area),
    [area, settings]
  )
  const fileName = background?.fileName ?? null
  const [loadedImage, setLoadedImage] = useState<{
    fileName: string
    objectUrl: string
  } | null>(null)
  const objectUrlRef = useRef<{
    objectUrl: string
    owner: BackgroundImageObjectUrlApi
  } | null>(null)
  const imageApi =
    dependencies.imageApi === undefined ? getBackgroundImageApi() : dependencies.imageApi
  const backgroundObjectUrls = dependencies.backgroundObjectUrls ?? browserBackgroundImageObjectUrls

  useEffect(() => {
    let cancelled = false
    if (objectUrlRef.current) {
      objectUrlRef.current.owner.revoke(objectUrlRef.current.objectUrl)
      objectUrlRef.current = null
    }
    setLoadedImage(null)

    if (!fileName) {
      return
    }

    void createAppearancePreviewBackgroundObjectUrl(fileName, imageApi, backgroundObjectUrls).then(
      (nextUrl) => {
        if (cancelled) {
          if (nextUrl) {
            backgroundObjectUrls.revoke(nextUrl)
          }
          return
        }
        objectUrlRef.current = nextUrl ? { objectUrl: nextUrl, owner: backgroundObjectUrls } : null
        setLoadedImage(nextUrl ? { fileName, objectUrl: nextUrl } : null)
      }
    )

    return () => {
      cancelled = true
    }
  }, [backgroundObjectUrls, fileName, imageApi])

  useEffect(
    () => () => {
      if (objectUrlRef.current) {
        objectUrlRef.current.owner.revoke(objectUrlRef.current.objectUrl)
        objectUrlRef.current = null
      }
    },
    []
  )

  return background && loadedImage?.fileName === background.fileName
    ? { ...background, objectUrl: loadedImage.objectUrl }
    : null
}
