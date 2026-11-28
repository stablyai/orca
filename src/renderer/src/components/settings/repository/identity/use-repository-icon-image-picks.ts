import { toast } from 'sonner'
import type { RepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import { faviconUrlFromWebsite } from '../../../../../../shared/repository/appearance/repo-icon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { repoIconPickFailureText } from './repo-icon-pick-failure-text'

const FAVICON_PROBE_TIMEOUT_MS = 10_000

/** Resolves whether the favicon URL loads as an image, so a failed fetch never replaces the current icon. */
function probeImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const image = new Image()
    const timer = window.setTimeout(() => settle(false), FAVICON_PROBE_TIMEOUT_MS)
    function settle(loaded: boolean): void {
      window.clearTimeout(timer)
      image.onload = null
      image.onerror = null
      resolve(loaded)
    }
    image.onload = () => settle(image.naturalWidth > 0)
    image.onerror = () => settle(false)
    image.src = src
  })
}

export type WebsiteFaviconFetchResult = 'applied' | 'invalid' | 'notFound' | 'superseded'

/** Image-sourced repo icons (uploaded PNG, website favicon), shared by Settings and the project card. */
export function useRepositoryIconImagePicks(
  onSetIcon: (repoIcon: RepoIcon | null) => void,
  options?: {
    /** Takes over the too-large toast, for callers that show the size error inline. */
    onTooLarge?: () => void
  }
): {
  uploadImage: () => Promise<void>
  /** Returns whether the URL resolved to a favicon. */
  applyWebsiteFavicon: (website: string) => boolean
  /** Loads the favicon first and applies it only if it loaded and `isCurrent` still holds. */
  fetchWebsiteFavicon: (
    website: string,
    isCurrent: () => boolean
  ) => Promise<WebsiteFaviconFetchResult>
} {
  const t = useTranslate()
  const mountedRef = useMountedRef()

  const uploadImage = async (): Promise<void> => {
    try {
      const result = await window.api.shell.pickRepoIconImage()
      if (!result || !mountedRef.current) {
        return
      }
      if ('error' in result) {
        if (result.errorCode === 'tooLarge' && options?.onTooLarge) {
          options.onTooLarge()
          return
        }
        toast.error(repoIconPickFailureText(result))
        return
      }
      onSetIcon({ type: 'image', src: result.dataUrl, source: 'upload', label: result.fileName })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(
              'auto.components.settings.RepositoryIconPicker.868c5c9b56',
              'Failed to import repo icon'
            )
      )
    }
  }

  const setFavicon = (src: string): void => {
    onSetIcon({
      type: 'image',
      src,
      source: 'favicon',
      label: t('auto.components.settings.RepositoryIconPicker.4d039317f4', 'Website favicon')
    })
  }

  const applyWebsiteFavicon = (website: string): boolean => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      toast.error(
        t('auto.components.settings.RepositoryIconPicker.acf31559a0', 'Enter a valid website URL.')
      )
      return false
    }
    setFavicon(src)
    return true
  }

  const fetchWebsiteFavicon = async (
    website: string,
    isCurrent: () => boolean
  ): Promise<WebsiteFaviconFetchResult> => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      return 'invalid'
    }
    const loaded = await probeImage(src)
    if (!loaded) {
      return 'notFound'
    }
    // A newer pick, reset or fetch made while this one loaded wins over it.
    if (!mountedRef.current || !isCurrent()) {
      return 'superseded'
    }
    setFavicon(src)
    return 'applied'
  }

  return { uploadImage, applyWebsiteFavicon, fetchWebsiteFavicon }
}
