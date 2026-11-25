import { toast } from 'sonner'
import type { RepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import { faviconUrlFromWebsite } from '../../../../../../shared/repository/appearance/repo-icon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { repoIconPickFailureText } from './repo-icon-pick-failure-text'

/** Image-sourced repo icons (uploaded PNG, website favicon), shared by Settings and the project card. */
export function useRepositoryIconImagePicks(onSetIcon: (repoIcon: RepoIcon | null) => void): {
  uploadImage: () => Promise<void>
  /** Returns whether the URL resolved to a favicon. */
  applyWebsiteFavicon: (website: string) => boolean
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

  const applyWebsiteFavicon = (website: string): boolean => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      toast.error(
        t('auto.components.settings.RepositoryIconPicker.acf31559a0', 'Enter a valid website URL.')
      )
      return false
    }
    onSetIcon({
      type: 'image',
      src,
      source: 'favicon',
      label: t('auto.components.settings.RepositoryIconPicker.4d039317f4', 'Website favicon')
    })
    return true
  }

  return { uploadImage, applyWebsiteFavicon }
}
