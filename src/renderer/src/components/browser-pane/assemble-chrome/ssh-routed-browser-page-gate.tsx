import { useEffect } from 'react'
import { Globe } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { DOC_PREVIEW_PARTITION } from '../../../../../shared/document-preview/doc-preview-scheme'
import { webviewRegistry } from '../host-guest/webview-registry'
import { replacePersistentWebview } from '../host-guest/browser-webview-disposal'
import { admitBrowserPageMount } from '../host-guest/browser-page-mount-admission'
import {
  useSshWorkspaceBrowserRoute,
  type SshWorkspaceBrowserRouteErrorKind
} from '../use-ssh-workspace-browser-route'

/** Require a proxy-verified partition before mounting SSH browser guests; local egress is allowed only through explicit global or per-target opt-outs. */
export function SshRoutedBrowserPageGate({
  worktreeId,
  sessionProfileId,
  pageIds,
  children
}: {
  worktreeId: string
  sessionProfileId: string | null
  /** Pages this gate guards; their guests are destroyed whenever they could browse off the verified route. */
  pageIds: readonly string[]
  children: (routedPartition: string | null) => React.JSX.Element
}): React.JSX.Element {
  const t = useTranslate()
  const { state, retry, tryWithoutProbe, browseFromThisDevice } = useSshWorkspaceBrowserRoute(
    worktreeId,
    sessionProfileId
  )
  const unrouted = state.kind === 'unrouted'
  const routedPartition = state.kind === 'ready' ? state.partition : null
  useEffect(() => {
    if (unrouted) {
      return
    }
    // Chrome unmount only parks guests; destroy pre-route guests so they cannot keep browsing with local egress behind the gate.
    for (const pageId of pageIds) {
      const webview = webviewRegistry.get(pageId)
      if (!webview) {
        continue
      }
      if (routedPartition) {
        const partition = webview.getAttribute('partition')
        // Guests already on the verified route (or a local doc preview) survive remounts without reloading.
        if (partition === routedPartition || partition === DOC_PREVIEW_PARTITION) {
          continue
        }
      }
      admitBrowserPageMount(pageId)
      void replacePersistentWebview(pageId)
    }
  }, [unrouted, routedPartition, pageIds])

  if (state.kind === 'unrouted') {
    return children(null)
  }
  if (state.kind === 'ready') {
    return children(state.partition)
  }
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-2">
        <Globe className="size-5 text-muted-foreground" />
        {state.kind === 'preparing' ? (
          <div className="text-sm font-medium text-foreground">
            {t('browser.sshRoute.preparingTitle', 'Connecting through the SSH host')}
          </div>
        ) : (
          <>
            <div className="text-sm font-medium text-foreground">
              {errorTitle(state.errorKind, t)}
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              {errorDescription(state.errorKind, t)}
            </div>
            {state.errorKind === 'unknown' ? (
              // Keep raw diagnostic errors collapsed beneath plain-language recovery.
              <details className="max-w-full text-xs leading-5 text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  {t('browser.sshRoute.showDetails', 'Show details')}
                </summary>
                <div className="mt-1 break-words">{state.message}</div>
              </details>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                {t('browser.sshRoute.retry', 'Retry')}
              </Button>
              {state.errorKind === 'forwarding-blocked' ? (
                <Button type="button" variant="outline" size="sm" onClick={tryWithoutProbe}>
                  {t('browser.sshRoute.tryAnyway', 'Try anyway')}
                </Button>
              ) : null}
              <Button type="button" variant="ghost" size="sm" onClick={browseFromThisDevice}>
                {t('browser.sshRoute.browseLocally', 'Browse from this device instead')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function errorTitle(kind: SshWorkspaceBrowserRouteErrorKind, t: Translate = translate): string {
  if (kind === 'forwarding-blocked') {
    return t('browser.sshRoute.forwardingBlockedTitle', 'The SSH server blocks browser traffic')
  }
  if (kind === 'ssh-unavailable') {
    return t('browser.sshRoute.sshUnavailableTitle', 'SSH connection unavailable')
  }
  return t('browser.sshRoute.errorTitle', 'SSH browser routing unavailable')
}

function errorDescription(
  kind: SshWorkspaceBrowserRouteErrorKind,
  t: Translate = translate
): string {
  if (kind === 'forwarding-blocked') {
    return t(
      'browser.sshRoute.forwardingBlockedDescription',
      'This server refuses TCP forwarding (often “AllowTcpForwarding no” in its sshd config), which browsing through it requires. Ask its administrator to allow forwarding, or browse from this device instead.'
    )
  }
  if (kind === 'ssh-unavailable') {
    return t(
      'browser.sshRoute.sshUnavailableDescription',
      "Pages in this workspace browse through its SSH host, and that connection isn't available right now. Reconnect the host, then retry."
    )
  }
  return t(
    'browser.sshRoute.errorDescription',
    'Pages in this workspace browse through its SSH host, and routing could not be set up.'
  )
}
