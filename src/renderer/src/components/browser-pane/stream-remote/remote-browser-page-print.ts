import { toast } from 'sonner'
import type { BrowserReadPrintPdfResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { readIpcErrorMessage } from '@/runtime/errors/ipc-error'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { streamDownloadedFile } from '@/runtime/files/reads/runtime-remote-file-download'
import type { RemoteBrowserDialogPage } from './remote-browser-javascript-dialog'

// One save per page at a time: a page's print() returns at once here, so a looping page can't stack dialogs.
const printingPages = new Set<string>()

/** A streamed page called print(): save it here as a PDF, then open that in this computer's viewer, where it prints. */
export async function saveRemoteBrowserPagePrint(
  page: RemoteBrowserDialogPage,
  { printId, title }: { printId: string; title: string }
): Promise<void> {
  const key = `${JSON.stringify(page.target)}\n${page.pageId}`
  if (printingPages.has(key)) {
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
        { timeoutMs: 60_000, suppressFeatureInteraction: true }
      )
    )
    if (!saved.canceled) {
      await window.api.shell.openFilePath(saved.destinationPath, LOCAL_EXECUTION_HOST_ID)
    }
  } catch (error) {
    toast.error(translate('browser.serverPage.print.failed', "Couldn't save the page as a PDF"), {
      description: readIpcErrorMessage(error) ?? String(error)
    })
  } finally {
    printingPages.delete(key)
  }
}
