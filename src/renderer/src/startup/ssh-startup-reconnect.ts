import type { SshConnectionState } from '../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getActiveSidebarWorkspaceId } from '../../../shared/workspace-scope'

export const SSH_STARTUP_RECONNECT_CONCURRENCY = 3

/**
 * Floor on the batch budget a task must still have when it takes a slot. Below this the attempt
 * would be killed before a connect could plausibly land, so it is skipped as `not-started-budget`
 * instead of burning a slot and reporting a misleading `timed-out` with a spurious onFailure.
 */
const MIN_ATTEMPT_BUDGET_MS = 250

export type SshStartupReconnectOutcome =
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'in-progress'
  | 'not-started-budget'
  | 'cancelled'

export type SshStartupReconnectBatchResult = {
  targetId: string
  outcome: SshStartupReconnectOutcome
}

export function shouldStartBackgroundSshReconnect(args: {
  backgroundTargetCount: number
  aborted: boolean
}): boolean {
  return !args.aborted && args.backgroundTargetCount > 0
}

type ScheduledReconnect = {
  targetId: string
  attemptTimeoutMs: number
  /** Wall-clock cap on the whole batch, or null to let the queue drain unbounded. */
  batchDeadline: number | null
  signal: AbortSignal
  connect: () => Promise<SshConnectionState | null>
  publishState: (state: SshConnectionState) => void
  onFailure: (error: unknown) => void
  resolve: (result: SshStartupReconnectBatchResult) => void
  started: boolean
  resultSettled: boolean
  released: boolean
  timer: ReturnType<typeof setTimeout> | null
  removeAbortListener: () => void
}

function remainingBudgetMs(deadline: number): number {
  return Math.max(0, deadline - performance.now())
}

function isConnectAlreadyInProgress(error: unknown): boolean {
  return error instanceof Error && /Connection to .+ is already in progress/.test(error.message)
}

export class SshStartupReconnectScheduler {
  private activeCount = 0
  private readonly queue: ScheduledReconnect[] = []

  constructor(private readonly concurrency = SSH_STARTUP_RECONNECT_CONCURRENCY) {}

  schedule(args: {
    targetId: string
    /**
     * Per-attempt cap, counted from the moment the task takes a slot — never from batch start.
     * With a `batchDeadline` the effective cap is the smaller of the two, so a task that reaches a
     * slot late gets only the budget the batch has left.
     */
    attemptTimeoutMs: number
    batchDeadline: number | null
    signal: AbortSignal
    connect: () => Promise<SshConnectionState | null>
    publishState: (state: SshConnectionState) => void
    onFailure: (error: unknown) => void
  }): Promise<SshStartupReconnectBatchResult> {
    return new Promise((resolve) => {
      const task: ScheduledReconnect = {
        ...args,
        resolve,
        started: false,
        resultSettled: false,
        released: false,
        timer: null,
        removeAbortListener: () => {}
      }
      const onAbort = (): void => {
        if (!task.started) {
          this.removeQueuedTask(task)
          this.clearTaskTimer(task)
          task.removeAbortListener()
          this.finish(task, 'cancelled')
          this.drain()
          return
        }
        this.finish(task, 'cancelled')
      }
      args.signal.addEventListener('abort', onAbort, { once: true })
      task.removeAbortListener = () => args.signal.removeEventListener('abort', onAbort)

      if (args.signal.aborted) {
        onAbort()
        return
      }
      if (task.batchDeadline !== null) {
        const queueBudgetMs = remainingBudgetMs(task.batchDeadline)
        if (queueBudgetMs < MIN_ATTEMPT_BUDGET_MS) {
          task.removeAbortListener()
          this.finish(task, 'not-started-budget')
          return
        }
        // Why: only the wait for a slot is batch-bounded. Once started, the task owns its own
        // timeout — otherwise a few slow front-of-queue connects would expire every target behind
        // them without ever calling connect, silently skipping those hosts for the session.
        task.timer = setTimeout(() => {
          task.timer = null
          this.removeQueuedTask(task)
          task.removeAbortListener()
          this.finish(task, 'not-started-budget')
          this.drain()
        }, queueBudgetMs - MIN_ATTEMPT_BUDGET_MS)
      }
      this.queue.push(task)
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      const expired =
        task.batchDeadline !== null && remainingBudgetMs(task.batchDeadline) < MIN_ATTEMPT_BUDGET_MS
      if (task.signal.aborted || expired) {
        this.clearTaskTimer(task)
        task.removeAbortListener()
        this.finish(task, task.signal.aborted ? 'cancelled' : 'not-started-budget')
        continue
      }
      this.start(task)
    }
  }

  private start(task: ScheduledReconnect): void {
    task.started = true
    this.activeCount++
    this.clearTaskTimer(task)
    // A batch deadline still caps a started attempt: the critical batch is awaited on the startup
    // path, so it must return within its budget no matter when the task reached a slot.
    const timeoutMs =
      task.batchDeadline === null
        ? task.attemptTimeoutMs
        : Math.min(task.attemptTimeoutMs, remainingBudgetMs(task.batchDeadline))
    task.timer = setTimeout(() => {
      task.timer = null
      if (!task.resultSettled && !task.signal.aborted) {
        const error = new Error('SSH reconnect timeout')
        task.onFailure(error)
        this.finish(task, 'timed-out')
      }
      // Why: connect gets no abort signal, so a hung IPC would hold its slot forever and
      // three of them would starve every later batch. The timeout caps the hold instead.
      this.release(task)
    }, timeoutMs)
    void Promise.resolve()
      .then(task.connect)
      .then(
        (state) => {
          if (!task.resultSettled && !task.signal.aborted) {
            if (state) {
              task.publishState(state)
            }
            this.finish(task, 'completed')
          }
          this.release(task)
        },
        (error: unknown) => {
          if (isConnectAlreadyInProgress(error)) {
            // Why: main already owns an attempt for this target and will publish its result via
            // the state-change push, so this task has no work left. Holding the slot until the
            // timeout would idle up to `concurrency` slots and starve the rest of the queue.
            this.finish(task, 'in-progress')
            this.release(task)
            return
          }
          if (!task.resultSettled && !task.signal.aborted) {
            task.onFailure(error)
            this.finish(task, 'failed')
          }
          this.release(task)
        }
      )
  }

  private finish(task: ScheduledReconnect, outcome: SshStartupReconnectOutcome): void {
    if (task.resultSettled) {
      return
    }
    task.resultSettled = true
    task.resolve({ targetId: task.targetId, outcome })
  }

  private release(task: ScheduledReconnect): void {
    if (task.released) {
      return
    }
    task.released = true
    this.clearTaskTimer(task)
    task.removeAbortListener()
    this.activeCount--
    this.drain()
  }

  private removeQueuedTask(task: ScheduledReconnect): void {
    const index = this.queue.indexOf(task)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
  }

  private clearTaskTimer(task: ScheduledReconnect): void {
    if (task.timer) {
      clearTimeout(task.timer)
      task.timer = null
    }
  }
}

const startupReconnectScheduler = new SshStartupReconnectScheduler()

export function resolveSshStartupActiveWorkspaceId(args: {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
}): string | null {
  return getActiveSidebarWorkspaceId(args.activeWorkspaceKey, args.activeWorktreeId)
}

export function partitionSshStartupReconnectTargets(args: {
  targetIds: readonly string[]
  activeTargetIds: readonly string[]
  activeTabId: string | null
  /**
   * SSH pty ids owned by the active workspace's tabs. Why: connection-owner resolution returns
   * `undefined` when the workspace's repo is missing from the local catalog, and folder workspaces
   * never key `remoteSessionIdsByTabId` at all (it is built from repo → connection), so the active
   * host would fall through to background. A tab's own pty id names the target either way.
   */
  activeWorkspaceSessionIds?: readonly string[]
  remoteSessionIdsByTabId?: Readonly<Record<string, string>>
}): { criticalTargetIds: string[]; backgroundTargetIds: string[] } {
  const targetIds = [...new Set(args.targetIds)]
  const eligible = new Set(targetIds)
  const activeTargets = new Set(args.activeTargetIds.filter((id) => eligible.has(id)))
  const sessionTargets = new Set<string>()
  const addSessionTarget = (sessionId: string, elevate: boolean): void => {
    const targetId = parseAppSshPtyId(sessionId)?.connectionId
    if (!targetId || !eligible.has(targetId)) {
      return
    }
    sessionTargets.add(targetId)
    if (elevate) {
      activeTargets.add(targetId)
    }
  }
  for (const [tabId, sessionId] of Object.entries(args.remoteSessionIdsByTabId ?? {})) {
    addSessionTarget(sessionId, tabId === args.activeTabId)
  }
  for (const sessionId of args.activeWorkspaceSessionIds ?? []) {
    addSessionTarget(sessionId, true)
  }
  const criticalTargetIds = targetIds.filter((targetId) => activeTargets.has(targetId))
  return {
    criticalTargetIds,
    backgroundTargetIds: [
      ...targetIds.filter(
        (targetId) => !activeTargets.has(targetId) && sessionTargets.has(targetId)
      ),
      ...targetIds.filter(
        (targetId) => !activeTargets.has(targetId) && !sessionTargets.has(targetId)
      )
    ]
  }
}

export function reconnectSshTargetsForRendererStartup(args: {
  targetIds: readonly string[]
  /**
   * Cap on a single connect once it holds a slot. When `batchBudgetMs` is set, the attempt is
   * capped at whichever of the two expires first, so a full per-host window is only guaranteed for
   * batches whose budget exceeds it — today, just the unbudgeted background batch.
   */
  attemptTimeoutMs: number
  /**
   * Cap on the whole batch, for the critical batch that startup awaits. Omit for fire-and-forget
   * batches: a shared batch cap plus bounded concurrency expires queued hosts without ever dialing
   * them, so a background host would silently lose its startup attempt entirely.
   */
  batchBudgetMs?: number
  signal: AbortSignal
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
  scheduler?: SshStartupReconnectScheduler
}): Promise<SshStartupReconnectBatchResult[]> {
  const batchDeadline =
    args.batchBudgetMs === undefined ? null : performance.now() + args.batchBudgetMs
  const scheduler = args.scheduler ?? startupReconnectScheduler
  return Promise.all(
    args.targetIds.map((targetId) =>
      scheduler.schedule({
        targetId,
        attemptTimeoutMs: args.attemptTimeoutMs,
        batchDeadline,
        signal: args.signal,
        connect: () => args.connect(targetId),
        publishState: (state) => args.publishState(targetId, state),
        onFailure: (error) => args.onFailure(targetId, error)
      })
    )
  )
}
