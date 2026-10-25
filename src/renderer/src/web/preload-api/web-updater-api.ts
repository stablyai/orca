import type { PreloadApi } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { noopUnsubscribe } from './web-storage'

export function createUpdaterApi(): NonNullable<Partial<PreloadApi>['updater']> {
  // Only desktop main can produce Linux install recovery; reject fake web results. Allocate each Error at the caller for its stack.
  const desktopOnlyMessage = 'Linux package install recovery is only available in the desktop app.'
  return {
    getVersion: () => Promise.resolve('web'),
    getStatus: () => Promise.resolve({ state: 'idle' } as never),
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    quitAndInstall: () => Promise.resolve(),
    dismissNudge: () => Promise.resolve(),
    dismissAvailableUpdate: () => Promise.resolve(),
    getLinuxPackageInstallInstructions: () => Promise.reject(new Error(desktopOnlyMessage)),
    showLinuxPackage: () => Promise.reject(new Error(desktopOnlyMessage)),
    // Why: the web client cannot install a desktop build, so channel switching
    // reports unavailable rather than an empty list that looks like a fetch miss.
    listBuilds: (channel) =>
      Promise.resolve({
        ok: false,
        channel,
        message: translate(
          'auto.components.settings.ReleaseChannelSection.webUnavailable',
          'Switching builds is only available in the desktop app.'
        )
      }),
    onStatus: () => noopUnsubscribe,
    onClearDismissal: () => noopUnsubscribe
  }
}
