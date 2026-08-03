import React, { useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Loader2, Workflow } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import type { OrchestrationCostReport } from '../../../../shared/orchestration-cost-report'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace-scope'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  formatOrchestrationCost,
  formatOrchestrationElapsed,
  formatOrchestrationTokens,
  getOrchestrationReportTotals,
  orchestrationReportNeedsDisclosure
} from './orchestration-cost-display'
import {
  selectOrchestrationStatusRun,
  type OrchestrationStatusSelection
} from './orchestration-status-selection'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import {
  useOrchestrationCostReport,
  type OrchestrationReportLoadError
} from './use-orchestration-cost-report'
import { OrchestrationUsageReportDetails } from './OrchestrationUsageReportDetails'

type SegmentProps = { compact: boolean; iconOnly: boolean }

function errorCopy(error: OrchestrationReportLoadError): string {
  if (error === 'older-runtime') {
    return translate(
      'auto.components.status.bar.OrchestrationUsageStatusSegment.olderRuntime',
      'Usage reports are unavailable on this runtime version.'
    )
  }
  if (error === 'run-not-found') {
    return translate(
      'auto.components.status.bar.OrchestrationUsageStatusSegment.runNotFound',
      'The linked orchestration run is no longer available.'
    )
  }
  return translate(
    'auto.components.status.bar.OrchestrationUsageStatusSegment.runtimeUnavailable',
    'The orchestration usage report is temporarily unavailable.'
  )
}

function reportTooltip(report: OrchestrationCostReport, stale: boolean): string {
  const totals = getOrchestrationReportTotals(report)
  const values = [
    formatOrchestrationElapsed(report.totals.elapsed.milliseconds),
    `${formatOrchestrationTokens(totals.tokens)} ${translate(
      'auto.components.status.bar.OrchestrationUsageStatusSegment.tokens',
      'tokens'
    )}`,
    formatOrchestrationCost(totals.cost)
  ].filter(Boolean)
  const qualifiers = [
    stale
      ? translate('auto.components.status.bar.OrchestrationUsageStatusSegment.stale', 'stale')
      : null,
    orchestrationReportNeedsDisclosure(report)
      ? translate('auto.components.status.bar.OrchestrationUsageStatusSegment.partial', 'partial')
      : null,
    report.totals.usage.attributionCertainty === 'inferred'
      ? translate('auto.components.status.bar.OrchestrationUsageStatusSegment.inferred', 'inferred')
      : translate(
          'auto.components.status.bar.OrchestrationUsageStatusSegment.attributionUnavailable',
          'attribution unavailable'
        )
  ].filter(Boolean)
  return `${translate(
    'auto.components.status.bar.OrchestrationUsageStatusSegment.title',
    'Orchestration usage'
  )} — ${values.join(' · ')} · ${qualifiers.join(', ')}`
}

function emptyTooltip(selection: OrchestrationStatusSelection): string {
  return selection.kind === 'ambiguous'
    ? translate(
        'auto.components.status.bar.OrchestrationUsageStatusSegment.ambiguousRun',
        'Orchestration usage — multiple active runs are linked to this workspace.'
      )
    : translate(
        'auto.components.status.bar.OrchestrationUsageStatusSegment.noRun',
        'Orchestration usage — no exact run is linked to this workspace.'
      )
}

export function OrchestrationUsageStatusView({
  compact,
  iconOnly,
  selection,
  report,
  error,
  stale,
  refreshing,
  open,
  onOpenChange
}: SegmentProps & {
  selection: OrchestrationStatusSelection
  report: OrchestrationCostReport | null
  error: OrchestrationReportLoadError | null
  stale: boolean
  refreshing: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const popoverTitleId = useId()
  const popoverContentRef = useRef<HTMLDivElement>(null)
  const totals = report ? getOrchestrationReportTotals(report) : null
  const tooltip = report
    ? reportTooltip(report, stale)
    : error
      ? errorCopy(error)
      : emptyTooltip(selection)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className={cn(
                'inline-flex cursor-pointer items-center rounded px-1 py-0.5 hover:bg-accent/70',
                compact ? 'gap-1' : 'gap-1.5'
              )}
              aria-label={tooltip}
            >
              {refreshing && !report ? (
                <Loader2 className="size-3 animate-spin text-muted-foreground" />
              ) : error && !report ? (
                <AlertTriangle className="size-3 text-muted-foreground" />
              ) : (
                <Workflow className="size-3 text-muted-foreground" />
              )}
              {!iconOnly && report && totals ? (
                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                  {formatOrchestrationElapsed(report.totals.elapsed.milliseconds)}
                  {!compact ? ` · ${formatOrchestrationTokens(totals.tokens)}` : ''}
                  {!compact && totals.cost !== null
                    ? ` · ${formatOrchestrationCost(totals.cost)}`
                    : ''}
                </span>
              ) : null}
              {!iconOnly && !report ? (
                <span className="text-[11px] text-muted-foreground">—</span>
              ) : null}
              {(stale || (report && orchestrationReportNeedsDisclosure(report))) && (
                <span className="size-1.5 rounded-full bg-muted-foreground" aria-hidden />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-sm">
          {tooltip}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        ref={popoverContentRef}
        tabIndex={-1}
        aria-labelledby={popoverTitleId}
        className="popover-scroll-content scrollbar-sleek max-h-[var(--radix-popover-content-available-height)] w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          popoverContentRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <Workflow className="size-3 text-muted-foreground" />
          <span id={popoverTitleId} className="text-[11px] font-medium text-foreground">
            {translate(
              'auto.components.status.bar.OrchestrationUsageStatusSegment.title',
              'Orchestration usage'
            )}
          </span>
        </div>
        {report && selection.kind === 'selected' ? (
          <OrchestrationUsageReportDetails
            report={report}
            stale={stale}
            source={selection.source}
          />
        ) : (
          <div className="flex items-start gap-2 px-3 py-3 text-[11px] text-muted-foreground">
            {selection.kind === 'ambiguous' || error ? (
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            ) : (
              <Workflow className="mt-0.5 size-3 shrink-0" />
            )}
            <span>{tooltip}</span>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function OrchestrationUsageStatusSegment({
  compact,
  iconOnly
}: SegmentProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const activeWorkspaceKey = useAppStore((state) => state.activeWorkspaceKey ?? null)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const agentStatuses = useAppStore((state) => state.agentStatusByPaneKey)
  const agentStatusEpoch = useAppStore((state) => state.agentStatusEpoch)
  const worktreeLineageById = useAppStore((state) => state.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((state) => state.workspaceLineageByChildKey)
  const terminalLayoutsByTabId = useAppStore((state) => state.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((state) => state.ptyIdsByTabId)
  const activeWorktree = useActiveWorktree()
  const workspaceId = getActiveSidebarWorkspaceId(activeWorkspaceKey, activeWorktreeId)
  const activeExecutionHostId = useAppStore((state) =>
    getExecutionHostIdForWorktree(state, workspaceId)
  )
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, workspaceId)
  )
  const target = useMemo<RuntimeClientTarget>(
    () =>
      runtimeEnvironmentId
        ? { kind: 'environment', environmentId: runtimeEnvironmentId }
        : { kind: 'local' },
    [runtimeEnvironmentId]
  )
  const selection = useMemo(() => {
    void agentStatusEpoch
    return selectOrchestrationStatusRun({
      activeWorkspaceKey,
      activeWorktreeId,
      activeWorktreeInstanceId: activeWorktree?.instanceId ?? null,
      activeExecutionHostId,
      now: Date.now(),
      agentStatuses: Object.values(agentStatuses),
      terminalLayoutsByTabId,
      ptyIdsByTabId,
      worktreeLineageById,
      workspaceLineageByChildKey
    })
  }, [
    activeExecutionHostId,
    activeWorkspaceKey,
    activeWorktree?.instanceId,
    activeWorktreeId,
    agentStatusEpoch,
    agentStatuses,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    workspaceLineageByChildKey,
    worktreeLineageById
  ])
  const runId = selection.kind === 'selected' ? selection.runId : null
  const load = useOrchestrationCostReport(target, runId, open)
  return (
    <OrchestrationUsageStatusView
      compact={compact}
      iconOnly={iconOnly}
      selection={selection}
      report={load.report}
      error={load.error}
      stale={load.stale}
      refreshing={load.refreshing}
      open={open}
      onOpenChange={setOpen}
    />
  )
}
