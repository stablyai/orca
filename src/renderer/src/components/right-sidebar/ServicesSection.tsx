import React, { useMemo, useState } from 'react'
import { ChevronRight, Loader2, RefreshCw, Server, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type {
  WorkspaceServiceScanResult,
  WorkspaceServiceStopRequest
} from '../../../../shared/workspace-services'
import {
  resolveServiceStopRequest,
  selectServicesForOtherWorktrees,
  selectServicesForWorktree
} from '../../../../shared/workspace-services'
import { ServiceRow } from './ServiceRow'
import { translate } from '@/i18n/i18n'

export function ServicesSection({
  scan,
  isRefreshing,
  error,
  repoId,
  worktreeId,
  orphanCount,
  onShowOrphans,
  onRefresh,
  onStop
}: {
  scan: WorkspaceServiceScanResult | null
  isRefreshing: boolean
  error: string | null
  repoId: string | null
  worktreeId: string | null
  orphanCount: number
  onShowOrphans: () => void
  onRefresh: () => void
  onStop: (request: WorkspaceServiceStopRequest, notifyAgent: boolean) => void
}): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [showOtherWorktrees, setShowOtherWorktrees] = useState(false)

  const services = scan?.services
  const active = useMemo(
    () => selectServicesForWorktree(services ?? [], worktreeId),
    [services, worktreeId]
  )
  const other = useMemo(
    () => selectServicesForOtherWorktrees(services ?? [], repoId, worktreeId),
    [repoId, services, worktreeId]
  )

  return (
    <div className="shrink-0 border-t border-border">
      <div className="flex h-8 items-center gap-1 px-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          aria-controls="workspace-services-list"
        >
          <ChevronRight
            size={12}
            className={cn('shrink-0 transition-transform', !collapsed && 'rotate-90')}
          />
          <span className="text-[11px] font-semibold uppercase tracking-wider">
            {translate('auto.components.right.sidebar.ServicesSection.0dce278f78', 'Services')}
          </span>
          {active.length > 0 && (
            <span className="ml-1 text-[10px] text-muted-foreground/60">{active.length}</span>
          )}
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-foreground"
              onClick={onRefresh}
              disabled={isRefreshing}
              aria-label={translate(
                'auto.components.right.sidebar.ServicesSection.7b483f5f0a',
                'Refresh Services'
              )}
            >
              {isRefreshing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.right.sidebar.ServicesSection.7b483f5f0a',
              'Refresh Services'
            )}
          </TooltipContent>
        </Tooltip>
      </div>

      {orphanCount > 0 && (
        <button
          type="button"
          className="mb-1 flex w-full items-center gap-1.5 border-t border-destructive/20 bg-destructive/10 px-2 py-1 text-left text-[11px] text-destructive transition-colors hover:bg-destructive/20"
          onClick={onShowOrphans}
        >
          <TriangleAlert size={12} className="shrink-0" />
          <span className="truncate">
            {orphanCount === 1
              ? translate(
                  'auto.components.right.sidebar.ServicesSection.d051e26f35',
                  '1 orphaned, workspace deleted'
                )
              : translate(
                  'auto.components.right.sidebar.ServicesSection.29db55fd54',
                  '{{value0}} orphaned, workspaces deleted',
                  { value0: orphanCount }
                )}
          </span>
        </button>
      )}

      {!collapsed && (
        <div
          id="workspace-services-list"
          className="max-h-56 overflow-y-auto px-2 pb-2 scrollbar-sleek"
        >
          {error && <div className="py-1 text-[11px] text-destructive">{error}</div>}

          {!error && scan?.unavailableReason && (
            <div className="py-1 text-[11px] text-muted-foreground">{scan.unavailableReason}</div>
          )}

          {!error && !scan?.unavailableReason && active.length === 0 && (
            <div className="flex items-center gap-2 py-2 text-[11px] text-muted-foreground">
              <Server size={13} className="opacity-50" />
              {isRefreshing && !scan
                ? translate(
                    'auto.components.right.sidebar.ServicesSection.cd70c78d76',
                    'Scanning...'
                  )
                : translate(
                    'auto.components.right.sidebar.ServicesSection.e187c588bf',
                    'No services running for this workspace'
                  )}
            </div>
          )}

          {active.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              showProject
              onStop={onStop}
              stopRequest={resolveServiceStopRequest(service, repoId)}
            />
          ))}

          {other.length > 0 && (
            <div className="mt-1 border-t border-border/40 pt-1">
              <button
                type="button"
                className="flex w-full items-center gap-1 py-1 text-left text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => setShowOtherWorktrees((value) => !value)}
                aria-expanded={showOtherWorktrees}
              >
                <ChevronRight
                  size={11}
                  className={cn('shrink-0 transition-transform', showOtherWorktrees && 'rotate-90')}
                />
                <span className="text-[10px] font-semibold uppercase tracking-wider">
                  {translate(
                    'auto.components.right.sidebar.ServicesSection.0e191f08a4',
                    'Other Workspaces'
                  )}
                </span>
                <span className="ml-1 text-[10px] text-muted-foreground/60">{other.length}</span>
              </button>
              {showOtherWorktrees &&
                other.map((service) => (
                  <ServiceRow
                    key={service.id}
                    service={service}
                    showProject
                    onStop={onStop}
                    stopRequest={resolveServiceStopRequest(service, repoId)}
                  />
                ))}
            </div>
          )}

          {scan && !scan.dockerAvailable && scan.dockerUnavailableReason && (
            <div className="pt-1 text-[10px] text-muted-foreground/70">
              {scan.dockerUnavailableReason}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
