import React from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  getSidebarHostVisibilityLabel,
  shouldShowHostScopeControls,
  type SidebarHostScopeOption
} from './sidebar-host-options'
import { useSidebarHostScopeOptions } from './use-sidebar-host-scope-options'
import { translate } from '@/i18n/i18n'

function HostScopeWarningIcon({ health }: { health: SidebarHostScopeOption['health'] }) {
  // Why: the banner stays quiet unless the scoped host needs attention.
  if (health === 'connecting') {
    return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  }
  if (health === 'blocked' || health === 'error') {
    return <AlertTriangle className="size-3 shrink-0 text-destructive" />
  }
  return null
}

/** Shown only when the sidebar is scoped to a single host: names the scope and
 *  offers the way back. In All-hosts view the host section headers tell the
 *  story, so no persistent strip renders; scope switching lives in the
 *  workspace options menu. */
const SidebarHostScopeStrip = React.memo(function SidebarHostScopeStrip() {
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const setVisibleWorkspaceHostIds = useAppStore((s) => s.setVisibleWorkspaceHostIds)
  const { hostOptions, hostScopeOptions } = useSidebarHostScopeOptions()

  if (!visibleWorkspaceHostIds) {
    return null
  }
  if (!shouldShowHostScopeControls(hostOptions)) {
    return null
  }

  const label = getSidebarHostVisibilityLabel(visibleWorkspaceHostIds, hostOptions)
  const selectedScope =
    visibleWorkspaceHostIds.length === 1
      ? hostScopeOptions.find((option) => option.id === visibleWorkspaceHostIds[0])
      : undefined

  return (
    <div className="px-2 pb-1">
      <div className="flex h-7 w-full items-center justify-between gap-2 rounded-md border border-sidebar-border/70 bg-sidebar-accent/35 pl-2 pr-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <HostScopeWarningIcon health={selectedScope?.health ?? 'available'} />
          <span className="truncate text-xs font-medium text-sidebar-foreground">
            {translate(
              'auto.components.sidebar.SidebarHostScopeStrip.scopedTo',
              '{{value0}} visible',
              {
                value0: label
              }
            )}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 shrink-0 gap-1 rounded px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setVisibleWorkspaceHostIds(null)}
        >
          <X className="size-3" />
          {translate('auto.components.sidebar.SidebarHostScopeStrip.backToAll', 'All hosts')}
        </Button>
      </div>
    </div>
  )
})

export default SidebarHostScopeStrip
