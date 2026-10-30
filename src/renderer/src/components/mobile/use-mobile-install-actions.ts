import { useCallback } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { Platform } from './MobileHero'
import { ANDROID_INSTALL_GUIDE_URL, getInstallCopy } from './mobile-platform-copy'
import { openAppHttpLink } from '@/lib/app-http-link-open'

export function useMobileInstallActions(platform: Platform): {
  copyInstallUrl: () => Promise<void>
  openAndroidInstallGuide: () => void
  openInstallUrl: () => void
} {
  const mountedRef = useMountedRef()

  const openInstallUrl = useCallback((): void => {
    openAppHttpLink(getInstallCopy(platform).url)
  }, [platform])

  const openAndroidInstallGuide = useCallback((): void => {
    openAppHttpLink(ANDROID_INSTALL_GUIDE_URL)
  }, [])

  const copyInstallUrl = useCallback(async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(getInstallCopy(platform).url)
      if (mountedRef.current) {
        toast.success(
          translate('auto.components.mobile.MobilePage.fad833de8d', 'Install link copied')
        )
      }
    } catch (error) {
      console.error('writeClipboardText failed', error)
      if (mountedRef.current) {
        toast.error(
          translate('auto.components.mobile.MobilePage.baea63c445', 'Failed to copy link')
        )
      }
    }
  }, [mountedRef, platform])

  return { copyInstallUrl, openAndroidInstallGuide, openInstallUrl }
}
