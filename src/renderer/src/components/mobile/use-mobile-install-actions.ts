import { useCallback } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { Platform } from './MobileHero'
import { getInstallCopy, type IosChannel } from './mobile-platform-copy'

export function useMobileInstallActions(
  platform: Platform,
  iosChannel: IosChannel
): { copyInstallUrl: () => Promise<void>; openInstallUrl: () => void } {
  const mountedRef = useMountedRef()

  const openInstallUrl = useCallback((): void => {
    void window.api.shell.openUrl(getInstallCopy(platform, iosChannel).url)
  }, [iosChannel, platform])

  const copyInstallUrl = useCallback(async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(getInstallCopy(platform, iosChannel).url)
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
  }, [iosChannel, mountedRef, platform])

  return { copyInstallUrl, openInstallUrl }
}
