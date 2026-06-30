import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  Lock,
  RefreshCw,
  Unlock,
  X
} from 'lucide-react'
import type { ScryerCompletionGateResult } from '../../../../shared/scryer/edit-session'

type DriftInfo = { nodeId: string; nodeName: string; patterns: string[] }

export type SyncStatus = 'idle' | 'running' | 'error'

export type SyncBarProps = {
  activeAgent: { name: string; available: boolean } | null
  driftedNodes: DriftInfo[]
  structureChanged: boolean
  implementing: boolean
  syncStatus: SyncStatus
  syncMessage: string | null
  syncLog: string[]
  completionGate?: ScryerCompletionGateResult | null
  projectPath: string | undefined
  onSync: () => void | Promise<void>
  onCancelSync: () => void | Promise<void>
  onFinishSync?: () => void | Promise<void>
  onCheckDrift?: () => void | Promise<void>
  onDismissMessage: () => void
  onDismissDrift: () => void | Promise<void>
  onToggleLock: () => void | Promise<void>
  onNavigateToNode?: (nodeId: string) => void
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function SyncBar({
  activeAgent,
  driftedNodes,
  structureChanged,
  implementing,
  syncStatus,
  syncMessage,
  syncLog,
  completionGate,
  projectPath,
  onSync,
  onCancelSync,
  onFinishSync,
  onCheckDrift,
  onDismissMessage,
  onDismissDrift,
  onToggleLock,
  onNavigateToNode
}: SyncBarProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const sortedDriftedNodes = useMemo(
    () => [...driftedNodes].sort((a, b) => a.nodeName.localeCompare(b.nodeName)),
    [driftedNodes]
  )
  const hasDrift = driftedNodes.length > 0 || structureChanged
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (syncStatus !== 'running') {
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Date.now() - startRef.current), 1000)
    return () => clearInterval(timer)
  }, [syncStatus])

  const isSuccess = syncStatus === 'idle' && !!syncMessage && !hasDrift
  const completionGateMessage = completionGate ? formatCompletionGateMessage(completionGate) : null
  const dismissRef = useRef(onDismissMessage)
  dismissRef.current = onDismissMessage
  useEffect(() => {
    if (!isSuccess) {
      return
    }
    const timer = setTimeout(() => dismissRef.current(), 5000)
    return () => clearTimeout(timer)
  }, [isSuccess])

  if (!projectPath) {
    return (
      <div
        className="shrink-0 border-t border-border bg-background"
        data-testid="architecture-sync-bar"
      >
        <div className="flex h-8 items-center gap-3 px-3 text-[11px] text-muted-foreground">
          No codebase linked yet
        </div>
      </div>
    )
  }

  const agentName = activeAgent?.available ? activeAgent.name : 'Orca agent'

  return (
    <div
      className="shrink-0 select-none border-t border-border bg-background"
      data-testid="architecture-sync-bar"
    >
      {syncStatus === 'running' ? (
        <div className="h-0.5 w-full overflow-hidden bg-border">
          <div className="h-full w-1/3 animate-[shimmer_1.5s_ease-in-out_infinite] bg-amber-500 dark:bg-amber-400" />
        </div>
      ) : null}

      <div className="flex h-8 items-center gap-3 px-3 text-[11px]">
        <div className="flex shrink-0 items-center gap-1.5">
          <div
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              syncStatus === 'running' ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'
            }`}
          />
          <span className="font-medium text-muted-foreground">{agentName}</span>
        </div>
        <div className="h-3 w-px bg-border" />

        {syncStatus === 'running' ? (
          <>
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1.5 text-amber-600 hover:text-amber-500 dark:text-amber-400"
              onClick={() => setExpanded((current) => !current)}
            >
              <Loader2 className="size-3 animate-spin" />
              <span>Syncing... {formatElapsed(elapsed)}</span>
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            </button>
            {syncLog.length > 0 ? (
              <span className="truncate text-muted-foreground">{syncLog.at(-1)}</span>
            ) : null}
            <div className="flex-1" />
            {onFinishSync ? (
              <button
                type="button"
                className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium text-emerald-600 transition-colors hover:bg-accent hover:text-emerald-500 dark:text-emerald-400"
                onClick={() => void onFinishSync()}
                data-testid="architecture-sync-finish"
              >
                <Check className="size-3" />
                Finish
              </button>
            ) : null}
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void onCancelSync()}
              data-testid="architecture-sync-cancel"
            >
              <X className="size-3" />
              Cancel
            </button>
          </>
        ) : implementing ? (
          <>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Lock className="size-3" />
              <span>Drift detection locked</span>
            </div>
            <div className="flex-1" />
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void onToggleLock()}
              title="Unlock drift detection"
              data-testid="architecture-sync-lock-toggle"
            >
              <Unlock className="size-3" />
              Unlock
            </button>
          </>
        ) : syncStatus === 'error' && syncMessage ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5 text-red-600 dark:text-red-400">
              <AlertCircle className="size-3 shrink-0" />
              <span className="truncate">{syncMessage}</span>
            </div>
            <button
              type="button"
              className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={onDismissMessage}
              title="Dismiss"
              data-testid="architecture-sync-dismiss"
            >
              <X className="size-3" />
            </button>
          </>
        ) : completionGateMessage && !hasDrift ? (
          <div
            className={`flex min-w-0 items-center gap-1.5 ${
              completionGate?.ok
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
            data-testid="architecture-sync-completion-gate"
          >
            {completionGate?.ok ? (
              <Check className="size-3 shrink-0" />
            ) : (
              <AlertCircle className="size-3 shrink-0" />
            )}
            <span className="truncate">{completionGateMessage}</span>
          </div>
        ) : syncMessage && !hasDrift ? (
          <div className="flex min-w-0 items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <Check className="size-3 shrink-0" />
            <span className="truncate">{syncMessage}</span>
          </div>
        ) : hasDrift ? (
          <>
            <div className="flex min-w-0 items-center gap-1.5">
              <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-500" />
              <button
                type="button"
                className="flex cursor-pointer items-center gap-1 text-foreground/80 transition-colors hover:text-foreground"
                onClick={() => driftedNodes.length > 0 && setExpanded((current) => !current)}
                data-testid="architecture-sync-drift"
              >
                <span>
                  {driftedNodes.length > 0
                    ? `${driftedNodes.length} node${driftedNodes.length === 1 ? '' : 's'} may have drifted`
                    : 'New files detected'}
                </span>
                {driftedNodes.length > 0 ? (
                  expanded ? (
                    <ChevronUp className="size-3 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="size-3 text-muted-foreground" />
                  )
                ) : null}
              </button>
            </div>

            {!expanded && sortedDriftedNodes.length > 0 ? (
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {sortedDriftedNodes.slice(0, 3).map((node) => (
                  <button
                    key={node.nodeId}
                    type="button"
                    className="max-w-[120px] cursor-pointer truncate rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] text-indigo-700 transition-colors hover:bg-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-400 dark:hover:bg-indigo-800/30"
                    onClick={() => onNavigateToNode?.(node.nodeId)}
                  >
                    {node.nodeName}
                  </button>
                ))}
                {sortedDriftedNodes.length > 3 ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    +{sortedDriftedNodes.length - 3} more
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="flex-1" />
            <button
              type="button"
              className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => void onDismissDrift()}
              title="Dismiss - mark as in sync"
              data-testid="architecture-sync-dismiss"
            >
              <X className="size-3" />
            </button>
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded bg-emerald-500 px-2.5 py-0.5 font-medium text-white transition-colors hover:bg-emerald-600"
              onClick={() => void onSync()}
              data-testid="architecture-sync-start"
            >
              <RefreshCw className="size-3" />
              Sync from codebase
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Check className="size-3 text-emerald-500" />
              <span>In sync</span>
            </div>
            <div className="flex-1" />
            <button
              type="button"
              className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => void onToggleLock()}
              title="Lock drift detection"
              data-testid="architecture-sync-lock-toggle"
            >
              <Lock className="size-3" />
            </button>
            {onCheckDrift ? (
              <button
                type="button"
                className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void onCheckDrift()}
                title="Check for code drift"
                data-testid="architecture-sync-drift"
              >
                <RefreshCw className="size-3" />
                Check
              </button>
            ) : null}
            <button
              type="button"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => void onSync()}
              data-testid="architecture-sync-start"
            >
              <RefreshCw className="size-3" />
              Sync
            </button>
          </>
        )}
      </div>

      {syncStatus === 'running' && expanded && syncLog.length > 0 ? (
        <div className="scrollbar-sleek max-h-32 space-y-0.5 overflow-y-auto border-t border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          {syncLog.map((line, index) => (
            <div key={`${line}-${index}`} className="truncate">
              {line}
            </div>
          ))}
        </div>
      ) : null}

      {expanded && sortedDriftedNodes.length > 0 && syncStatus === 'idle' ? (
        <div className="space-y-1 border-t border-border px-3 py-1.5">
          {sortedDriftedNodes.map((node) => (
            <button
              key={node.nodeId}
              type="button"
              className="-mx-1 flex w-full cursor-pointer items-center gap-2 rounded px-1 text-left text-[11px] transition-colors hover:bg-accent"
              onClick={() => onNavigateToNode?.(node.nodeId)}
            >
              <span className="font-medium text-foreground/80">{node.nodeName}</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {node.patterns.join(', ')}
              </span>
            </button>
          ))}
          {structureChanged ? (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium text-foreground/80">Project structure</span>
              <span className="text-[10px] text-muted-foreground">New files detected</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function formatCompletionGateMessage(gate: ScryerCompletionGateResult): string {
  switch (gate.nextAction) {
    case 'nothing_to_fold':
      return 'No model changes to fold'
    case 'fold_allowed': {
      const count = gate.pending.total
      return `${count} pending change${count === 1 ? '' : 's'} ready to fold`
    }
    case 'fix_validation': {
      const count = gate.validation.blockingCount
      return `Fix ${count} validation error${count === 1 ? '' : 's'} before folding`
    }
    case 'manual_review':
      return 'Manual review required before folding'
    case 'blocked_by_lease':
      return 'Edit session blocked by another lease'
  }
}
