import type { MouseEvent as ReactMouseEvent } from 'react'
import { toast } from 'sonner'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getLocalFileManager } from '@/lib/files/os-open/local-file-manager-label'

// How long the toast offers the copy; the host holds it 2 min, and hovering pauses the toast.
const OFFER_TOAST_MS = 10_000
// Drop the button before the host's hold runs out, so a late click never fails.
const OFFER_BUTTON_MS = 100_000

type DownloadCopyOffer = {
  toastId: string
  target: RuntimeClientTarget & { kind: 'environment' }
  copyId: string
  // The server's finish line: "Saved to <path> on <host>".
  savedOnServer: string
  filename: string
}

/** The server's finish toast, with Save to this computer while the server holds the copy. */
export function offerRemoteBrowserDownloadCopy(offer: DownloadCopyOffer): void {
  const { toastId, target, copyId, savedOnServer } = offer
  // A copy id names a file only on the pairing that sent it; a re-paired host must not answer for it.
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId
  )
  const release = (): void => {
    void callRuntimeRpc(
      target,
      'browser.releaseDownloadCopy',
      { copyId },
      { suppressFeatureInteraction: true, background: true, expectedEnvironmentPairingRevision }
    ).catch(() => {})
  }
  let settled = false
  const settle = (): boolean => {
    if (settled) {
      return false
    }
    settled = true
    clearTimeout(buttonTimer)
    return true
  }
  const buttonTimer = setTimeout(() => {
    if (settle()) {
      release()
      toast.success(savedOnServer, { ...plainToast(toastId), duration: OFFER_TOAST_MS })
    }
  }, OFFER_BUTTON_MS)
  toast.success(savedOnServer, {
    id: toastId,
    duration: OFFER_TOAST_MS,
    action: {
      label: translate('browser.serverPage.download.saveHere', 'Save to this computer'),
      onClick: (event: ReactMouseEvent) => {
        // The same toast shows the copy.
        event.preventDefault()
        if (settle()) {
          void copyHere(offer, expectedEnvironmentPairingRevision)
        }
      }
    },
    // The person let it go: the server need not hold the copy.
    onDismiss: () => {
      if (settle()) {
        release()
      }
    },
    onAutoClose: () => {
      if (settle()) {
        release()
      }
    }
  })
}

async function copyHere(
  { toastId, target, copyId, filename }: DownloadCopyOffer,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<void> {
  toast.loading(
    translate('browser.serverPage.download.copying', 'Downloading {{filename}} to this computer…', {
      filename
    }),
    {
      ...plainToast(toastId),
      closeButton: false,
      action: {
        label: translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel'),
        onClick: (event: ReactMouseEvent) => {
          event.preventDefault()
          // Main refuses it once the file is being moved into Downloads; the copy then ends as usual.
          void window.api.browser.cancelServerDownloadCopy({ copyId })
        }
      }
    }
  )
  try {
    // Main writes each slice straight to disk; no bytes pass through this window.
    const result = await window.api.browser.copyServerDownload({
      environmentId: target.environmentId,
      copyId,
      filename,
      ...(expectedEnvironmentPairingRevision === undefined
        ? {}
        : { expectedEnvironmentPairingRevision })
    })
    if (result.canceled) {
      // The server's copy stays; nothing was left here.
      toast.dismiss(toastId)
      return
    }
    const { destinationPath } = result
    toast.success(
      translate('browser.serverPage.download.copied', 'Saved to {{path}}', {
        path: destinationPath
      }),
      {
        ...plainToast(toastId),
        action: {
          label:
            getLocalFileManager() === 'finder'
              ? translate('auto.components.settings.CliSection.6f894ef9c2', 'Show in Finder')
              : translate('browser.serverPage.download.showInFolder', 'Show in Folder'),
          onClick: () => {
            void window.api.shell.openPath(destinationPath, LOCAL_EXECUTION_HOST_ID)
          }
        }
      }
    )
  } catch (error) {
    toast.error(
      translate(
        'browser.serverPage.download.copyFailed',
        "Couldn't save {{filename}} to this computer.",
        { filename }
      ),
      { ...plainToast(toastId), description: readIpcErrorMessage(error) ?? String(error) }
    )
  }
}

/** Sonner merges updates into the toast with this id, so clear what an earlier state set. */
function plainToast(toastId: string) {
  return {
    id: toastId,
    action: undefined,
    description: undefined,
    closeButton: undefined,
    duration: undefined,
    onDismiss: undefined,
    onAutoClose: undefined
  }
}
