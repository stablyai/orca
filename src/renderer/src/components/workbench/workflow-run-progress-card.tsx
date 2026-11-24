import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, FolderOpen, RotateCcw, Square, X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useTranslate } from '@/i18n/use-translate'
import type { NodeRunLog, WorkflowRunRecord } from './use-workflow-runner'

function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDuration(startedAt?: number, finishedAt?: number, now?: number): string | null {
  if (!startedAt) {
    return null
  }
  const end = finishedAt ?? now ?? startedAt
  const sec = Math.max(0, Math.round((end - startedAt) / 1000))
  return `${sec}s`
}

function WaypointNodeDot({ node }: { node: NodeRunLog }): React.JSX.Element {
  if (node.status === 'pass') {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-workflow-progress bg-background text-workflow-progress">
        <Check className="size-3" strokeWidth={2.5} />
      </span>
    )
  }
  if (node.status === 'active') {
    return (
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 animate-spin rounded-full border-2 border-dashed border-workflow-progress [animation-duration:6s]" />
        <span className="size-1.5 rounded-full bg-workflow-progress" />
      </span>
    )
  }
  if (node.status === 'attention') {
    return (
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-dashed border-status-warning" />
        <span className="size-1.5 rounded-full bg-status-warning" />
      </span>
    )
  }
  if (node.kind === 'commit' || node.kind === 'accept') {
    return (
      <span className="relative flex size-5 shrink-0 items-center justify-center">
        <span className="absolute inset-0 rounded-full border-2 border-dashed border-status-warning/70" />
        <span className="size-1 rounded-full bg-status-warning/70" />
      </span>
    )
  }
  return (
    <span className="size-5 shrink-0 rounded-full border border-muted-foreground/35 bg-background" />
  )
}

export function WorkflowRunProgressCard({
  activeRun,
  onStop,
  onRetry,
  onOpenWorktree,
  onClose
}: {
  activeRun: WorkflowRunRecord
  onStop: () => void
  onRetry: () => void
  onOpenWorktree?: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [now, setNow] = useState(() => Date.now())
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!activeRun.running) {
      return
    }
    // Elapsed-time cadence pauses while hidden; visibility transitions resume it.
    return installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 1000 })
  }, [activeRun.running])

  const totalSteps = activeRun.nodes.length
  const completedCount = activeRun.nodes.filter((n) => n.status === 'pass').length
  const activeIdx = activeRun.nodes.findIndex(
    (n) => n.status === 'active' || n.status === 'attention'
  )
  const currentStep =
    activeIdx !== -1
      ? activeIdx + 1
      : Math.min(completedCount + (activeRun.finished ? 0 : 1), totalSteps)
  const runCode = activeRun.id.slice(-4)
  const elapsedMs = (activeRun.finishedAt ?? now) - activeRun.startedAt

  const statusMeta = activeRun.error
    ? {
        text: t('workbench.waypoints.needsYou', 'waiting for you'),
        color: 'text-status-warning'
      }
    : activeRun.running
      ? {
          text: t('workbench.waypoints.running', 'running'),
          color: 'text-workflow-progress'
        }
      : activeRun.finished
        ? {
            text: t('workbench.waypoints.completed', 'completed'),
            color: 'text-workspace-status-review'
          }
        : {
            text: t('workbench.waypoints.stopped', 'stopped'),
            color: 'text-muted-foreground'
          }

  const toggleExpand = (nodeId: string): void => {
    setExpandedIds((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }))
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border/75 bg-card/90 p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold tracking-tight text-foreground">
            {activeRun.requirement}
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">
              {t('auto.components.workbench.flow.runLabel', 'Run {{code}}', { code: runCode })}
            </span>
            <span>·</span>
            <span className={cn('font-medium', statusMeta.color)}>{statusMeta.text}</span>
            <span>·</span>
            <span>
              {t('auto.components.workbench.flow.stepProgress', 'step {{current}} of {{total}}', {
                current: currentStep,
                total: totalSteps
              })}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-muted-foreground">
          <span className="font-mono text-xs tabular-nums">{formatClock(elapsedMs)}</span>
          {activeRun.running ? (
            <button
              type="button"
              onClick={onStop}
              title={t('auto.components.workbench.flow.stop', 'Stop')}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              title={t('workbench.waypoints.close', '返回工作流配置')}
              className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {activeRun.nodes.map((node) => (
          <div key={node.nodeId} className="h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                node.status === 'pass' && 'w-full bg-workflow-progress',
                node.status === 'active' && 'w-2/3 animate-pulse bg-workflow-progress',
                node.status === 'attention' && 'w-1/2 bg-status-warning',
                node.status === 'idle' && 'w-0'
              )}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-col">
        {activeRun.nodes.map((node, idx) => {
          const isLast = idx === totalSteps - 1
          const isCurrent = node.status === 'active' || node.status === 'attention'
          const isExpanded = isCurrent || Boolean(expandedIds[node.nodeId])
          const hasDetails = Boolean(node.output || node.error || node.status === 'active')
          const showDetour = isExpanded && hasDetails
          const duration = formatDuration(
            node.startedAt,
            node.finishedAt,
            node.status === 'active' ? now : undefined
          )
          const firstLine = (node.output ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
          const railColor = node.status === 'pass' ? 'stroke-workflow-progress' : 'stroke-border'

          return (
            <div key={node.nodeId} className="flex flex-col">
              <div className="relative flex items-center gap-3 py-1.5">
                {!isLast && !showDetour ? (
                  <span
                    className={cn(
                      'pointer-events-none absolute top-7 bottom-[-8px] left-[9.5px] w-px',
                      node.status === 'pass' ? 'bg-workflow-progress/80' : 'bg-border/80'
                    )}
                  />
                ) : null}

                <WaypointNodeDot node={node} />

                <button
                  type="button"
                  disabled={!hasDetails || isCurrent}
                  onClick={() => toggleExpand(node.nodeId)}
                  className={cn(
                    'flex min-w-0 flex-1 items-center justify-between gap-2 text-left text-[13px]',
                    hasDetails && !isCurrent && 'cursor-pointer hover:text-foreground'
                  )}
                >
                  <span
                    className={cn(
                      'truncate',
                      isCurrent ? 'font-medium text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {node.label}
                  </span>

                  <span className="flex shrink-0 items-center gap-2 text-xs">
                    {node.status === 'attention' ? (
                      <span className="font-medium text-status-warning">
                        {t('workbench.waypoints.needsYouBadge', 'Needs you')}
                      </span>
                    ) : node.status === 'idle' &&
                      (node.kind === 'commit' || node.kind === 'accept') ? (
                      <span className="text-status-warning/85">
                        {t('workbench.waypoints.asksFirst', 'Asks first')}
                      </span>
                    ) : null}
                    {duration ? (
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
                        {duration}
                      </span>
                    ) : null}
                    {node.status === 'pass' && hasDetails ? (
                      isExpanded ? (
                        <ChevronUp className="size-3.5 text-muted-foreground/60" />
                      ) : (
                        <ChevronDown className="size-3.5 text-muted-foreground/60" />
                      )
                    ) : null}
                  </span>
                </button>
              </div>

              {showDetour ? (
                <div className="relative pl-9">
                  <svg
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0 left-0 h-full w-9 overflow-visible"
                    preserveAspectRatio="none"
                  >
                    <path
                      d="M 10 -6 C 10 8, 28 6, 28 20"
                      fill="none"
                      strokeWidth="1.5"
                      className={
                        node.status === 'attention' ? 'stroke-workflow-progress' : railColor
                      }
                    />
                    <line
                      x1="28"
                      y1="20"
                      x2="28"
                      y2="100%"
                      strokeWidth="1.5"
                      className={
                        node.status === 'pass' ? 'stroke-workflow-progress/70' : 'stroke-border'
                      }
                    />
                  </svg>

                  <div className="flex flex-col gap-2 py-1.5">
                    {firstLine || node.status === 'active' ? (
                      <div className="relative flex items-center justify-between gap-2 text-xs">
                        <span
                          className={cn(
                            'absolute top-1.5 -left-[11.5px] size-2 rounded-full border-2 bg-background',
                            node.status === 'active'
                              ? 'animate-pulse border-workflow-progress'
                              : 'border-workflow-progress'
                          )}
                        />
                        <span className="truncate text-foreground/90">
                          {firstLine || t('workbench.waypoints.working', 'Working on step...')}
                        </span>
                        {node.meta ? (
                          <span className="shrink-0 truncate font-mono text-[11px] text-muted-foreground/80">
                            {node.meta}
                          </span>
                        ) : null}
                      </div>
                    ) : null}

                    {node.error ? (
                      <div className="relative rounded-xl border border-status-warning/25 bg-status-warning/8 p-3.5">
                        <span className="absolute top-4 -left-[11.5px] size-2 rounded-full bg-status-warning shadow-[0_0_8px_rgba(251,191,36,0.7)]" />
                        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                          {node.error}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={onRetry}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-status-warning/30 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background"
                          >
                            <RotateCcw className="size-3" />
                            {t('auto.components.workbench.flow.retry', '重试此步')}
                          </button>
                          {onOpenWorktree && activeRun.worktreeId ? (
                            <button
                              type="button"
                              onClick={onOpenWorktree}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/50 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                            >
                              <FolderOpen className="size-3" />
                              {t('auto.components.workbench.flow.viewWorktree', '查看工作区')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}

                    {node.output && node.output.includes('\n') ? (
                      <pre className="max-h-36 overflow-auto scrollbar-sleek rounded-lg border border-border/50 bg-background/50 p-2 font-mono text-[11px] text-muted-foreground">
                        {node.output}
                      </pre>
                    ) : null}
                  </div>

                  {!isLast ? (
                    <svg
                      aria-hidden="true"
                      className="pointer-events-none absolute -bottom-2 left-0 h-5 w-9 overflow-visible"
                    >
                      <path
                        d="M 28 0 C 28 12, 10 8, 10 22"
                        fill="none"
                        strokeWidth="1.5"
                        className={
                          node.status === 'pass' ? 'stroke-workflow-progress/70' : 'stroke-border'
                        }
                      />
                    </svg>
                  ) : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {activeRun.finished && onOpenWorktree && activeRun.worktreeId ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3">
          <button
            type="button"
            onClick={onOpenWorktree}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background/70 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-background"
          >
            <FolderOpen className="size-3.5" />
            {t('auto.components.workbench.flow.openWorktree', 'Open Worktree')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
