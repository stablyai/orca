import { useEffect } from 'react'
import { toast } from 'sonner'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue
} from '@/components/confirmation-dialog-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function openConfirmedExternalLink(url: string): Promise<void> {
  try {
    const opened = await useAppStore.getState().openBrowserProfileTabInActiveWorkspace(url, null)
    if (opened) {
      return
    }
  } catch {
    // The same reader-facing result covers refusal and rejection.
  }
  toast.error(
    translate(
      'auto.hooks.ipc.events.browserStateIpcBridge.docPreviewLinkFailed',
      'Could not open this link in Orca Browser.'
    )
  )
}

export function subscribeDocPreviewExternalLinkConfirmation(
  confirm: ConfirmationDialogContextValue
): () => void {
  if (typeof window.api.docPreview?.onExternalLink !== 'function') {
    return () => {}
  }
  let active = true
  const unsubscribe = window.api.docPreview.onExternalLink(({ url }) => {
    void confirm({
      title: translate(
        'auto.components.browserPane.workspaceDoc.externalLinkTitle',
        'Open link to {{host}}?',
        { host: displayHost(url) }
      ),
      description: url,
      descriptionClassName: 'break-all font-mono text-xs',
      confirmLabel: translate(
        'auto.components.browserPane.workspaceDoc.externalLinkConfirm',
        'Open link'
      ),
      cancelLabel: translate(
        'auto.components.browserPane.workspaceDoc.externalLinkCancel',
        'Cancel'
      )
    }).then((confirmed) => {
      if (active && confirmed) {
        void openConfirmedExternalLink(url)
      }
    })
  })
  return () => {
    active = false
    unsubscribe()
  }
}

export function DocPreviewExternalLinkConfirmation(): null {
  const confirm = useConfirmationDialog()
  useEffect(() => subscribeDocPreviewExternalLinkConfirmation(confirm), [confirm])
  return null
}
