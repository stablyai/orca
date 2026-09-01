import React from 'react'
import { AlertTriangle, ChevronRight, MemoryStick, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { WorkspaceSpaceCompactPanel } from './WorkspaceSpaceCompactPanel'
import { ResourceUsageAppSection } from './ResourceUsageAppSection'
import {
  CPU_COLUMN_CLS,
  formatCpu,
  formatMemory,
  MEM_COLUMN_CLS,
  METRIC_COLUMNS_CLS,
  ROW_TRAILING_GUTTER_CLS
} from './ResourceUsageMetrics'
import { ResourceUsageTree } from './ResourceUsageTree'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import type { ResourceUsageActions } from './use-resource-usage-actions'
import type { ResourceUsageFoundation } from './use-resource-usage-foundation'
import type { ResourceUsageProjection } from './use-resource-usage-projection'

export function ResourceUsagePopoverContent({
  foundation,
  projection,
  actions
}: {
  foundation: ResourceUsageFoundation
  projection: ResourceUsageProjection
  actions: ResourceUsageActions
}): React.JSX.Element {
  const {
    sortOption,
    setSortOption,
    daemonActions,
    resourceSnapshot,
    setPopoverBodyNode,
    collapsedRepos,
    collapsedWorktrees,
    activeWorktreeId,
    appCollapsed,
    setAppCollapsed
  } = foundation
  const {
    daemonUnreachable,
    sessionsOnlyError,
    totalCpu,
    totalMemory,
    memoryMetricCopy,
    orphanCount,
    unifiedRepos
  } = projection
  const {
    toggleRepo,
    toggleWorktree,
    navigateToWorktree,
    navigateToTab,
    deleteWorktree,
    handleKillSession,
    handleOpenWorkspaceCleanup,
    handleKillOrphans,
    openSpaceResults
  } = actions

  return (
    <PopoverContent
      side="top"
      align="end"
      sideOffset={8}
      {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
      className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
      onOpenAutoFocus={(event) => event.preventDefault()}
      // Why: xterm focus must not dismiss the resource manager after tab activation.
      onFocusOutside={(event) => event.preventDefault()}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
          <MemoryStick className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {translate('auto.components.status.bar.StatusBar.d1e1a7a6bf', 'Resource Manager')}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => daemonActions.setPending('restart')}
                disabled={daemonActions.isBusy}
                aria-label={translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
                  'Restart daemon'
                )}
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <RotateCw className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.c9382662bb',
                'Restart daemon'
              )}
            </TooltipContent>
          </Tooltip>
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => daemonActions.setPending('killAll')}
                disabled={daemonActions.isBusy}
                aria-label={translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
                  'Kill all sessions'
                )}
                className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              >
                <Trash2 className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.bd19fd7a59',
                'Kill all sessions'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {daemonUnreachable && (
        <div className="flex items-start gap-2 border-b border-border bg-yellow-500/10 px-3 py-2 text-[11px] text-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0 text-yellow-500" />
          <div className="flex-1">
            <div className="font-medium">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.f8e0d794b4',
                'Daemon is not responding'
              )}
            </div>
            <div className="text-muted-foreground">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.f85af9cda6',
                'Resource snapshots and terminal sessions are unavailable.'
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => daemonActions.setPending('restart')}
            disabled={daemonActions.isBusy}
          >
            <RotateCw className="mr-1 size-3" />
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.93b0de3c21',
              'Restart'
            )}
          </Button>
        </div>
      )}

      {!daemonUnreachable && sessionsOnlyError && (
        <div
          className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground"
          role="status"
        >
          <AlertTriangle className="size-3 shrink-0 text-yellow-500" />
          <span>
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.e7cf14ec78',
              'Terminal sessions unavailable. The list may be stale.'
            )}
          </span>
        </div>
      )}

      {resourceSnapshot && (
        <div className="px-3 py-2 border-b border-border flex items-baseline justify-between gap-3 text-xs tabular-nums">
          <div className="flex items-baseline gap-3 min-w-0">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                >
                  {formatCpu(totalCpu)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                {translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.1fedf94eae',
                  'Combined CPU load. Values above 100% mean more than one core is working at once.'
                )}
              </TooltipContent>
            </Tooltip>
            <span className="text-muted-foreground/50">·</span>
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:rounded"
                >
                  {formatMemory(totalMemory)}{' '}
                  <span className="font-normal text-muted-foreground">
                    {memoryMetricCopy.summaryLabel}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} className="z-[70] max-w-xs">
                {memoryMetricCopy.description}
              </TooltipContent>
            </Tooltip>
          </div>
          {orphanCount > 0 && (
            <span className="shrink-0 text-yellow-500" aria-live="polite">
              {orphanCount === 1
                ? translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.30ff2c3c31',
                    '{{value0}} orphan',
                    { value0: orphanCount }
                  )
                : translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.b8f4a2c1d0e3',
                    '{{value0}} orphans',
                    { value0: orphanCount }
                  )}
            </span>
          )}
        </div>
      )}

      {/* Why: fixed height prevents list expansion and polling from moving the popover. */}
      <div ref={setPopoverBodyNode} tabIndex={-1} className="flex h-[420px] flex-col outline-none">
        {(unifiedRepos.length > 0 || resourceSnapshot) && (
          <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b border-border/50 text-[10px] uppercase tracking-wide shrink-0">
            <button
              type="button"
              onClick={() => setSortOption('name')}
              className={cn(
                'hover:text-foreground transition-colors',
                sortOption === 'name' ? 'font-semibold text-foreground' : 'text-muted-foreground/80'
              )}
              aria-pressed={sortOption === 'name'}
            >
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.2aa2de6cb9',
                'Name'
              )}
            </button>
            <div className="flex items-center gap-2 shrink-0">
              <div className={cn(METRIC_COLUMNS_CLS, 'text-[10px]')}>
                <button
                  type="button"
                  onClick={() => setSortOption('cpu')}
                  className={cn(
                    CPU_COLUMN_CLS,
                    'hover:text-foreground transition-colors',
                    sortOption === 'cpu'
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground/80'
                  )}
                  aria-pressed={sortOption === 'cpu'}
                >
                  {translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.298f4be7f2',
                    'CPU'
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setSortOption('memory')}
                  className={cn(
                    MEM_COLUMN_CLS,
                    'hover:text-foreground transition-colors',
                    sortOption === 'memory'
                      ? 'font-semibold text-foreground'
                      : 'text-muted-foreground/80'
                  )}
                  aria-pressed={sortOption === 'memory'}
                >
                  {memoryMetricCopy.columnLabel}
                </button>
              </div>
              <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-sleek">
          {unifiedRepos.length > 0 && (
            <ResourceUsageTree
              repos={unifiedRepos}
              sortOption={sortOption}
              collapsedRepos={collapsedRepos}
              toggleRepo={toggleRepo}
              collapsedWorktrees={collapsedWorktrees}
              activeWorktreeId={activeWorktreeId}
              toggleWorktree={toggleWorktree}
              navigateToWorktree={navigateToWorktree}
              navigateToTab={navigateToTab}
              onDelete={deleteWorktree}
              onKillSession={handleKillSession}
            />
          )}

          {unifiedRepos.length === 0 && resourceSnapshot && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.27a74f91f0',
                'Nothing running right now'
              )}
            </div>
          )}

          {resourceSnapshot && (
            <ResourceUsageAppSection
              app={resourceSnapshot.app}
              isCollapsed={appCollapsed}
              onToggle={() => setAppCollapsed((value) => !value)}
            />
          )}

          {!resourceSnapshot && !daemonUnreachable && (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.888dad8c55',
                'Loading…'
              )}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/50 px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={handleOpenWorkspaceCleanup}
          className="relative inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
        >
          <span className="min-w-0 truncate px-4 text-center">
            {translate(
              'auto.components.status.bar.ResourceUsageStatusSegment.92924a14e3',
              'Clean up workspaces'
            )}
          </span>
          <ChevronRight className="absolute right-2.5 size-3.5 text-muted-foreground" aria-hidden />
        </button>
        {orphanCount > 0 ? (
          <button
            type="button"
            onClick={() => void handleKillOrphans()}
            className="mt-2 inline-flex w-full items-center justify-center rounded-md border border-border/70 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60"
          >
            {orphanCount === 1
              ? translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.c7e3b1a0d9f2',
                  'Kill {{value0}} orphan terminal',
                  { value0: orphanCount }
                )
              : translate(
                  'auto.components.status.bar.ResourceUsageStatusSegment.d8f4c2b1e0a3',
                  'Kill {{value0}} orphan terminals',
                  { value0: orphanCount }
                )}
          </button>
        ) : null}
      </div>

      <WorkspaceSpaceCompactPanel onOpenFullPage={openSpaceResults} />
    </PopoverContent>
  )
}
