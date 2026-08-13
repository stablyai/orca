import React, { useCallback, useEffect, useState } from 'react'
import { AppWindow } from 'lucide-react'
import { toast } from 'sonner'
import {
  OPEN_WITH_CHOOSER_APPLICATION_ID,
  type ShellOpenWithApplication
} from '../../../../shared/shell-open-types'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { isLocalPathOpenBlocked } from '@/lib/local-path-open-guard'

type OpenWithListingState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; applications: ShellOpenWithApplication[]; supportsChooserDialog: boolean }
  | { status: 'unavailable' }

/** True only for local file rows on the desktop client, the one case where OS handlers apply. */
export function shouldShowOpenWithSubmenu(
  node: { isDirectory: boolean },
  connectionId: string | null | undefined,
  settings: { activeRuntimeEnvironmentId?: string | null } | null | undefined
): boolean {
  if (node.isDirectory) {
    return false
  }
  // Why: OS handler discovery and launching both run on this client's machine;
  // web clients and remote (SSH / on-demand runtime) files have no local path.
  if ((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true) {
    return false
  }
  return !isLocalPathOpenBlocked(settings, { connectionId })
}

/** Open With submenu; discovery starts the first time it opens. */
export function FileExplorerOpenWithSubmenu({ filePath }: { filePath: string }): React.JSX.Element {
  const [listing, setListing] = useState<OpenWithListingState>({ status: 'idle' })
  // Why: discovery spawns OS tools — only pay for it once the user opens the
  // submenu, not on every context-menu open.
  const [discoveryRequested, setDiscoveryRequested] = useState(false)

  useEffect(() => {
    setListing({ status: 'idle' })
    setDiscoveryRequested(false)
  }, [filePath])

  useEffect(() => {
    if (!discoveryRequested) {
      return
    }
    let disposed = false
    setListing({ status: 'loading' })
    window.api.shell
      .listOpenWithApplications(filePath)
      .then((result) => {
        if (disposed) {
          return
        }
        setListing(
          result.ok
            ? {
                status: 'ready',
                applications: result.applications,
                supportsChooserDialog: result.supportsChooserDialog
              }
            : { status: 'unavailable' }
        )
      })
      .catch(() => {
        if (!disposed) {
          setListing({ status: 'unavailable' })
        }
      })
    return () => {
      disposed = true
    }
  }, [filePath, discoveryRequested])

  const handleOpenWithApplication = useCallback(
    (applicationId: string) => {
      const showOpenFailedToast = (): void => {
        toast.error(
          translate(
            'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.openFailed',
            'Could not open the file with the selected application.'
          )
        )
      }
      void window.api.shell
        .openPathWithApplication({ path: filePath, applicationId })
        .then((result) => {
          if (!result.ok) {
            showOpenFailedToast()
          }
        })
        .catch(showOpenFailedToast)
    },
    [filePath]
  )

  return (
    <ContextMenuSub
      onOpenChange={(open) => {
        if (open) {
          setDiscoveryRequested(true)
        }
      }}
    >
      <ContextMenuSubTrigger>
        <AppWindow />
        {translate(
          'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.openWith',
          'Open With'
        )}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        {(listing.status === 'idle' || listing.status === 'loading') && (
          <ContextMenuItem disabled>
            {translate(
              'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.loading',
              'Looking for applications...'
            )}
          </ContextMenuItem>
        )}
        {listing.status === 'unavailable' && (
          <ContextMenuItem disabled>
            {translate(
              'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.unavailable',
              'Applications are unavailable for this file.'
            )}
          </ContextMenuItem>
        )}
        {listing.status === 'ready' && listing.applications.length === 0 && (
          <ContextMenuItem disabled>
            {translate(
              'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.noApplications',
              'No applications found'
            )}
          </ContextMenuItem>
        )}
        {listing.status === 'ready' &&
          listing.applications.map((application) => (
            <ContextMenuItem
              key={application.id}
              onSelect={() => handleOpenWithApplication(application.id)}
            >
              <span className="min-w-0 truncate">{application.name}</span>
              {application.isDefault ? (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.defaultBadge',
                    'Default'
                  )}
                </span>
              ) : null}
            </ContextMenuItem>
          ))}
        {listing.status === 'ready' && listing.supportsChooserDialog && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => handleOpenWithApplication(OPEN_WITH_CHOOSER_APPLICATION_ID)}
            >
              {translate(
                'auto.components.right.sidebar.FileExplorerOpenWithSubmenu.chooseAnotherApp',
                'Choose another app...'
              )}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
