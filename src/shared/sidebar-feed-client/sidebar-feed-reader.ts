import type {
  SidebarInputsChangedEvent,
  SidebarInputsReadParams,
  SidebarInputsReadResult
} from '../sidebar-list/sidebar-inputs-feed-contract'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReadFailed,
  sidebarInputsReplied,
  type SidebarInputsFeedRequest,
  type SidebarInputsFeedStep
} from '../sidebar-list/sidebar-inputs-feed-installer'
import { installSidebarFeedSnapshot, type SidebarFeedSnapshot } from './sidebar-feed-snapshot'

/** One `sidebarInputs.read` as the platform carried it; a rejected promise reads as `failed`. */
export type SidebarFeedReadOutcome =
  | { kind: 'answered'; reply: SidebarInputsReadResult }
  /** The host has no feed (method_not_found, or forbidden by an older allowlist). */
  | { kind: 'unavailable' }
  | { kind: 'failed' }

export type SidebarFeedTransport = (
  params: SidebarInputsReadParams
) => Promise<SidebarFeedReadOutcome>

export type SidebarFeedNotice = Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>

export type SidebarFeedReaderRead = {
  snapshot: SidebarFeedSnapshot | null
  unavailable: boolean
  /** This read settled every host write answered before it was sent, with no remaining pages. */
  settledBy: number | null
}

export type SidebarFeedReaderOptions = {
  /** Retry delay after consecutive failures; null stops. Installs/refresh reset the count. */
  retryDelayMs: (failures: number) => number | null
}

/** Serialize whole-batch reads, follow notices/retry failures, and preserve unchanged entity objects in immutable installs. */
export class SidebarFeedReader {
  private state = INITIAL_SIDEBAR_INPUTS_FEED_STATE
  private snapshot: SidebarFeedSnapshot | null = null
  private unavailable = false
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0

  constructor(
    private readonly transport: SidebarFeedTransport,
    private readonly options: SidebarFeedReaderOptions,
    private readonly onRead: (read: SidebarFeedReaderRead) => void
  ) {}

  /** Reads past every notice so far, superseding a read in flight; returns that read's id. */
  refresh(): number {
    this.failures = 0
    this.apply(refreshSidebarInputs(this.state))
    return this.state.lastRequestId
  }

  changed(notice: SidebarFeedNotice): void {
    this.apply(sidebarInputsChanged(this.state, notice))
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private emit(settledBy: number | null): void {
    this.onRead({ snapshot: this.snapshot, unavailable: this.unavailable, settledBy })
  }

  /** `answered`: the read whose reply produced this step, when it was the one in flight. */
  private apply(step: SidebarInputsFeedStep, answered: number | null = null): void {
    const before = this.state.installed
    this.state = step.state
    const { installed } = step.state
    const installs = installed !== null && installed !== before
    if (installs) {
      // Only an install ends a failure streak: a page that answers mid-batch does not.
      this.failures = 0
      this.snapshot = installSidebarFeedSnapshot(installed, this.snapshot)
    }
    const settledBy = answered !== null && !step.request && installed ? answered : null
    if (installs || settledBy !== null) {
      this.emit(settledBy)
    }
    if (step.request) {
      this.send(step.request)
    }
  }

  /** Reads again from what is installed, which the host answers past every notice so far. */
  private retry(): void {
    const delay = this.options.retryDelayMs(this.failures)
    if (this.disposed || this.retryTimer || delay === null) {
      return
    }
    this.failures += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.state.inFlight === null) {
        this.apply(refreshSidebarInputs(this.state))
      }
    }, delay)
  }

  private failed(request: SidebarInputsFeedRequest): void {
    if (this.disposed || request.id !== this.state.inFlight) {
      return
    }
    this.state = sidebarInputsReadFailed(this.state, request.id)
    if (!this.unavailable) {
      this.retry()
    }
  }

  private send(request: SidebarInputsFeedRequest): void {
    this.transport(request.params).then(
      (outcome) => {
        if (this.disposed) {
          return
        }
        if (outcome.kind === 'answered') {
          const answered = this.state.inFlight === request.id ? request.id : null
          this.apply(sidebarInputsReplied(this.state, request.id, outcome.reply), answered)
          return
        }
        if (outcome.kind === 'unavailable' && !this.unavailable) {
          this.unavailable = true
          this.emit(null)
        }
        this.failed(request)
      },
      () => this.failed(request)
    )
  }
}
