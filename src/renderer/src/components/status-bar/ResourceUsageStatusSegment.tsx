import React from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { DaemonActionDialog } from '../shared/useDaemonActions'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { useResourceUsageStatusController } from './use-resource-usage-status-controller'
import { renderResourceUsageStatusTrigger } from './resource-usage-status-trigger'
import {
  renderDaemonUnreachableBanner,
  renderResourceUsagePopoverHeader,
  renderResourceUsageSummary,
  renderSessionsOnlyErrorBanner
} from './resource-usage-popover-summary'
import {
  renderResourceUsagePopoverBody,
  renderResourceUsagePopoverFooter
} from './resource-usage-popover-body'
import { renderResourceUsageKillDialog } from './resource-usage-kill-dialog'
import { WorkspaceSpaceCompactPanel } from './WorkspaceSpaceCompactPanel'

export { SessionRow, WorktreeRow } from './resource-usage-session-rows'

// ─── Top-level segment ──────────────────────────────────────────────

export function ResourceUsageStatusSegment({
  iconOnly
}: {
  compact?: boolean
  iconOnly: boolean
}): React.JSX.Element {
  const controller = useResourceUsageStatusController()
  const {
    open,
    setOpen,
    sortOption,
    setSortOption,
    collapsedRepos,
    collapsedWorktrees,
    appCollapsed,
    setAppCollapsed,
    activeWorktreeId,
    killConfirm,
    setKillConfirm,
    killing,
    setPopoverBodyNode,
    daemonActions,
    resourceSnapshot,
    spaceScanReady,
    recordFeatureInteraction,
    unifiedRepos,
    orphanCount,
    triggerSessionCount,
    memoryMetricCopy,
    commitMetricCopy,
    totalMemory,
    totalCpu,
    memBadgeLabel,
    commitToneClass,
    commitBadgeLabel,
    daemonUnreachable,
    sessionsOnlyError,
    resourceManagerTooltipLines,
    resourceManagerAriaLabel,
    toggleRepo,
    toggleWorktree,
    navigateToWorktree,
    navigateToTab,
    deleteWorktree,
    handleOpenWorkspaceCleanup,
    handleKillSession,
    handleKillOrphans,
    runKillConfirmed,
    openSpaceResults
  } = controller

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          recordFeatureInteraction('resource-manager')
        }
        setOpen(nextOpen)
      }}
    >
      {renderResourceUsageStatusTrigger({
        daemonUnreachable,
        resourceManagerAriaLabel,
        spaceScanReady,
        iconOnly,
        commitToneClass,
        memBadgeLabel,
        triggerSessionCount,
        orphanCount,
        resourceManagerTooltipLines
      })}

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Why: activating a tab focuses xterm's DOM node; Radix would read that as focus-outside and close. Outside-click and Escape still close.
        onFocusOutside={(event) => event.preventDefault()}
      >
        {renderResourceUsagePopoverHeader({ daemonActions })}
        {daemonUnreachable && renderDaemonUnreachableBanner({ daemonActions })}
        {!daemonUnreachable && sessionsOnlyError && renderSessionsOnlyErrorBanner()}
        {resourceSnapshot &&
          renderResourceUsageSummary({
            totalCpu,
            totalMemory,
            memoryMetricCopy,
            commitBadgeLabel,
            commitMetricCopy,
            commitToneClass,
            orphanCount
          })}
        {/* Why: fixed 420px height so the popover doesn't jump as worktrees expand/collapse or sessions change; inner tree owns its scroll. */}
        {renderResourceUsagePopoverBody({
          setPopoverBodyNode,
          unifiedRepos,
          resourceSnapshot,
          sortOption,
          setSortOption,
          memoryMetricCopy,
          collapsedRepos,
          toggleRepo,
          collapsedWorktrees,
          activeWorktreeId,
          toggleWorktree,
          navigateToWorktree,
          navigateToTab,
          deleteWorktree,
          handleKillSession,
          appCollapsed,
          setAppCollapsed,
          daemonUnreachable
        })}
        {renderResourceUsagePopoverFooter({
          handleOpenWorkspaceCleanup,
          orphanCount,
          handleKillOrphans
        })}
        <WorkspaceSpaceCompactPanel onOpenFullPage={openSpaceResults} />
      </PopoverContent>
      {/* Why: hoisted to a sibling of PopoverContent — nested, the Dialog unmounts with the popover mid-interaction and the kill-confirm flow disappears. */}
      {renderResourceUsageKillDialog({
        killConfirm,
        setKillConfirm,
        killing,
        runKillConfirmed
      })}
      <DaemonActionDialog api={daemonActions} />
    </Popover>
  )
}
