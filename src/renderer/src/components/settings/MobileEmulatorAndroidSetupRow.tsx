import { ExternalLink, FolderOpen, X } from 'lucide-react'
import { useState } from 'react'
import type { AndroidSetupStatus } from '../../../../shared/emulator-setup-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { MobileEmulatorToolchainRow } from './MobileEmulatorToolchainRow'

const ANDROID_STUDIO_URL = 'https://developer.android.com/studio'

export function MobileEmulatorAndroidSetupRow({
  status,
  configuredPath,
  onSetSdkPath,
  localActionsAvailable
}: {
  status: AndroidSetupStatus
  configuredPath?: string | null
  onSetSdkPath: (path: string | null) => Promise<void>
  localActionsAvailable: boolean
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const ready = status.state === 'ready'

  const locate = async (): Promise<void> => {
    try {
      const path = await window.api.shell.pickDirectory({ defaultPath: status.sdkPath })
      if (path) {
        await onSetSdkPath(path)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the Android SDK folder.')
    }
  }

  const openStudio = async (): Promise<void> => {
    if (!status.studioPath) {
      return
    }
    if (!(await window.api.shell.openFilePath(status.studioPath))) {
      setError('Could not open Android Studio.')
    }
  }

  const clearConfiguredPath = async (): Promise<void> => {
    try {
      await onSetSdkPath(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear the Android SDK folder.')
    }
  }

  const detail = status.sdkPath ? (
    <>
      {status.message} <code className="rounded bg-muted px-1 py-0.5">{status.sdkPath}</code>
    </>
  ) : (
    status.message
  )

  return (
    <MobileEmulatorToolchainRow
      ready={ready}
      title={translate(
        'auto.components.settings.MobileEmulatorAndroidSetupRow.title',
        'Android Emulator'
      )}
      detail={detail}
      error={error}
      actions={
        localActionsAvailable ? (
          <>
            {!ready ? (
              status.studioInstalled && status.studioPath ? (
                <Button type="button" size="sm" onClick={() => void openStudio()}>
                  <ExternalLink />
                  {translate(
                    'auto.components.settings.MobileEmulatorAndroidSetupRow.open',
                    'Open Android Studio'
                  )}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void window.api.shell.openUrl(ANDROID_STUDIO_URL)}
                >
                  {translate(
                    'auto.components.settings.MobileEmulatorAndroidSetupRow.download',
                    'Download Android Studio'
                  )}
                </Button>
              )
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={() => void locate()}>
              <FolderOpen />
              {translate(
                'auto.components.settings.MobileEmulatorAndroidSetupRow.locate',
                'Locate SDK folder'
              )}
            </Button>
            {configuredPath ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void clearConfiguredPath()}
              >
                <X />
                {translate(
                  'auto.components.settings.MobileEmulatorAndroidSetupRow.clear',
                  'Use automatic detection'
                )}
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  )
}
