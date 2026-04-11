import { createElement } from 'react'
import { toast } from 'sonner'
import type { UpdateStatus } from '../../../shared/types'
import { useAppStore } from '../store'

type ReleaseToastStatus = Extract<UpdateStatus, { state: 'available' | 'downloaded' }>

type ToastApi = Pick<typeof toast, 'loading' | 'info' | 'success' | 'error' | 'dismiss'>

type UpdaterApi = {
  download: () => Promise<void>
  quitAndInstall: () => Promise<unknown>
}

type StoreApi = {
  getDismissedVersion: () => string | null
  dismissUpdate: () => void
}

function getReleaseUrl(status: ReleaseToastStatus): string {
  return status.releaseUrl ?? `https://github.com/stablyai/orca/releases/tag/v${status.version}`
}

export function createUpdateToastController(deps?: {
  toastApi?: ToastApi
  updaterApi?: UpdaterApi
  storeApi?: StoreApi
}): {
  handleStatus: (status: UpdateStatus) => void
} {
  const toastApi = deps?.toastApi ?? toast
  const updaterApi = deps?.updaterApi ?? window.api.updater
  const storeApi: StoreApi = deps?.storeApi ?? {
    getDismissedVersion: () => useAppStore.getState().dismissedUpdateVersion,
    dismissUpdate: () => useAppStore.getState().dismissUpdate()
  }

  let checkingToastId: string | number | undefined
  let availableToastId: string | number | undefined
  const downloadToastId = 'update-download-progress'
  // Why: the old updater UX was a single toast flow. Remember whether the
  // user clicked the toast's update action so auto-download installs can
  // finish in one step instead of showing a second bottom-right prompt.
  let autoRestartAfterDownload = false

  const showRestartFailure = (message: string): void => {
    toastApi.error('Could not restart to install the update.', {
      description: message
    })
  }

  const requestRestartInstall = (): void => {
    void updaterApi.quitAndInstall().catch((error) => {
      autoRestartAfterDownload = false
      showRestartFailure(String((error as Error)?.message ?? error))
    })
  }

  return {
    handleStatus(status) {
      // Why: update checks are a new lifecycle. Clearing the one-click
      // install intent here prevents a stale flag from a previous release
      // from auto-restarting on an unrelated later download.
      if (status.state === 'checking' || status.state === 'error') {
        autoRestartAfterDownload = false
      }

      if (status.state === 'checking' && 'userInitiated' in status && status.userInitiated) {
        checkingToastId = toastApi.loading('Checking for updates...')
      } else if (status.state === 'idle') {
        if (checkingToastId) {
          // Why: a user-initiated check that resolves to idle (rather than
          // 'not-available') means the check couldn't complete — this can
          // happen because a new release is being published and the update
          // manifest is temporarily unavailable, or because of a transient
          // network failure.  We use a neutral message that is honest for
          // both scenarios instead of claiming a rollout is in progress
          // (misleading when the real cause is a network blip).
          toastApi.info('Unable to check for updates right now. We\'ll try again shortly.', {
            id: checkingToastId
          })
          checkingToastId = undefined
        }
      } else if (status.state === 'not-available') {
        if ('userInitiated' in status && status.userInitiated) {
          toastApi.success("You're on the latest version.", { id: checkingToastId })
          checkingToastId = undefined
        }
      } else if (status.state === 'available') {
        if (checkingToastId) {
          toastApi.dismiss(checkingToastId)
        }
        checkingToastId = undefined
        // Why: if the user previously dismissed this exact version, don't
        // re-show the toast. This preserves the old UpdateReminder behavior
        // where dismissedUpdateVersion was checked before rendering.
        if (storeApi.getDismissedVersion() === status.version) {
          return
        }
        const releaseUrl = getReleaseUrl(status)
        availableToastId = toastApi.info(`Version ${status.version} is available.`, {
          description: createElement(
            'a',
            {
              href: releaseUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { textDecoration: 'underline' }
            },
            'Release notes'
          ),
          duration: Infinity,
          // Why: when the user closes the toast without clicking Update,
          // persist the dismissed version so the same release doesn't
          // re-appear on the next check or app restart.
          onDismiss: () => storeApi.dismissUpdate(),
          action: {
            label: 'Update',
            onClick: () => {
              autoRestartAfterDownload = true
              void updaterApi.download()
            }
          }
        })
      } else if (status.state === 'downloading') {
        if (availableToastId) {
          toastApi.dismiss(availableToastId)
          availableToastId = undefined
        }
        toastApi.loading(`Downloading v${status.version}… ${status.percent}%`, {
          id: downloadToastId,
          duration: Infinity
        })
      } else if (status.state === 'downloaded') {
        if (availableToastId) {
          toastApi.dismiss(availableToastId)
          availableToastId = undefined
        }
        toastApi.dismiss(downloadToastId)
        if (autoRestartAfterDownload) {
          autoRestartAfterDownload = false
          requestRestartInstall()
          return
        }
        const releaseUrl = getReleaseUrl(status)
        toastApi.success(`Version ${status.version} is ready to install.`, {
          description: createElement(
            'a',
            {
              href: releaseUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { textDecoration: 'underline' }
            },
            'Release notes'
          ),
          duration: Infinity,
          action: {
            label: 'Restart Now',
            onClick: () => {
              requestRestartInstall()
            }
          }
        })
      } else if (status.state === 'error') {
        toastApi.dismiss(downloadToastId)
        if ('userInitiated' in status && status.userInitiated) {
          toastApi.error('Could not check for updates.', {
            description: createElement(
              'span',
              null,
              status.message,
              ' You can download the latest version manually from ',
              createElement(
                'a',
                {
                  href: 'https://github.com/stablyai/orca/releases/latest',
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: { textDecoration: 'underline' }
                },
                'our GitHub releases page'
              ),
              '.'
            ),
            id: checkingToastId
          })
          checkingToastId = undefined
        }
      }
    }
  }
}
