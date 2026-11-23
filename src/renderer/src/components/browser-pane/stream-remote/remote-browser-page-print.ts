import { toast } from 'sonner'
import type { BrowserReadPrintPdfResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { streamDownloadedFile } from '@/runtime/files/reads/runtime-remote-file-download'
import type { RemoteBrowserDialogPage } from './remote-browser-javascript-dialog'

// One save per page at a time; the host also holds one print per page until it is read or released.
const printingPages = new Set<string>()

/** A streamed page called print(): save it here as a PDF, then open that in this computer's viewer, where it prints. */
export async function saveRemoteBrowserPagePrint(
  page: RemoteBrowserDialogPage,
  { printId, title }: { printId: string; title: string }
): Promise<void> {
  // A print id names a PDF only on the pairing that sent it; a re-paired host must not answer for it.
  const expectedEnvironmentPairingRevision =
    page.target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(page.target.environmentId)
      : undefined
  // A print this pane won't read is released, so the page can print again.
  const release = (): void => {
    void callRuntimeRpc(
      page.target,
      'browser.releasePrintPdf',
      { printId },
      { suppressFeatureInteraction: true, background: true, expectedEnvironmentPairingRevision }
    ).catch(() => {})
  }
  const key = `${JSON.stringify(page.target)}\n${page.pageId}`
  if (printingPages.has(key)) {
    release()
    return
  }
  printingPages.add(key)
  try {
    const name = `${title.trim().slice(0, 120) || 'page'}.pdf`
    const saved = await streamDownloadedFile(name, (offset) =>
      callRuntimeRpc<BrowserReadPrintPdfResult>(
        page.target,
        'browser.readPrintPdf',
        { printId, offset },
        { timeoutMs: 60_000, suppressFeatureInteraction: true, expectedEnvironmentPairingRevision }
      )
    )
    if (saved.canceled) {
      release()
    } else {
      await window.api.shell.openFilePath(saved.destinationPath, LOCAL_EXECUTION_HOST_ID)
    }
  } catch (error) {
    release()
    toast.error(translate('browser.serverPage.print.failed', "Couldn't save the page as a PDF"), {
      description: readIpcErrorMessage(error) ?? String(error)
    })
  } finally {
    printingPages.delete(key)
  }
}
