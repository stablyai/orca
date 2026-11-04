import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { DocPreviewGrantOwner } from '../../../../../preload/api/doc-preview-api'
import { captureHttpLinkIntent, openOwnedHttpLink } from '@/lib/http-link-routing'
import { resolveMarkdownPreviewHttpOpenOptions } from '@/components/editor/markdown-preview-links'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

type DocPreviewLinkSource = {
  grantId: string
  owner: DocPreviewGrantOwner
  worktreeId: string
  browserWorkspaceId: string
}

export function subscribeDocPreviewExternalLinkConfirmation(
  confirm: ConfirmationDialogContextValue,
  source: DocPreviewLinkSource
): () => void {
  if (typeof window.api.docPreview?.onExternalLink !== 'function') {
    return () => {}
  }
  let active = true
  const unsubscribe = window.api.docPreview.onExternalLink(({ url, grantId, modifiers }) => {
    if (grantId !== source.grantId) {
      return
    }
    const state = useAppStore.getState()
    const wrapper = state.unifiedTabsByWorktree[source.worktreeId]?.find(
      (tab) => tab.contentType === 'browser' && tab.entityId === source.browserWorkspaceId
    )
    const options = {
      ...resolveMarkdownPreviewHttpOpenOptions(
        modifiers ?? { metaKey: false, ctrlKey: false, shiftKey: false },
        navigator.userAgent.includes('Mac'),
        source.worktreeId,
        source.owner.kind === 'ssh'
          ? source.owner
          : { kind: 'runtime', runtimeEnvironmentId: source.owner.environmentId }
      ),
      allowRemoteInApp: true,
      allowClientBrowserFallback: true,
      linkContext: { linkIntent: captureHttpLinkIntent(source.worktreeId, wrapper?.id) }
    }
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
        openOwnedHttpLink(url, options)
      }
    })
  })
  return () => {
    active = false
    unsubscribe()
  }
}
