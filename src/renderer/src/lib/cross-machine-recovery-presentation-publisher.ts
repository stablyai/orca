import type {
  RecoveryPresentationPublishParams,
  RecoveryPresentationPublishResult,
  RecoveryPresentationWorkspace
} from '../../../shared/cross-machine-recovery-presentation-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export const PRESENTATION_PUBLISH_DEBOUNCE_MS = 2_000
export const PRESENTATION_PUBLISH_MAX_WAIT_MS = 10_000
export const PRESENTATION_INPUT_PUBLISH_INTERVAL_MS = 60_000
export const PRESENTATION_PUBLISH_BACKOFF_MIN_MS = 5_000
export const PRESENTATION_PUBLISH_BACKOFF_MAX_MS = 5 * 60_000

export type PresentationPublishTransport = {
  supportsHost: (hostId: ExecutionHostId) => Promise<boolean>
  publish: (
    hostId: ExecutionHostId,
    params: RecoveryPresentationPublishParams
  ) => Promise<RecoveryPresentationPublishResult>
}

export type CrossMachineRecoveryPresentationPublisher = {
  viewChanged: () => void
  inputChanged: () => void
  workspaceFocusChanged: () => void
  dispose: () => void
}

type HostLane = {
  revision: number
  inFlight: boolean
  dirty: boolean
  backoffMs: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

type SendOutcome = 'done' | 'retry'

export function createCrossMachineRecoveryPresentationPublisher(options: {
  clientInstanceId: string
  clientName: string
  localHostSupported: boolean
  snapshot: () => Map<ExecutionHostId, RecoveryPresentationWorkspace[]>
  transport: PresentationPublishTransport
}): CrossMachineRecoveryPresentationPublisher {
  const lanes = new Map<ExecutionHostId, HostLane>()
  let trailingTimer: ReturnType<typeof setTimeout> | null = null
  let inputTimer: ReturnType<typeof setTimeout> | null = null
  let firstPendingChangeAt: number | null = null
  let lastFlushAt: number | null = null
  let disposed = false

  // Why: SSH hosts have no presentation store; their export stays 'host-bindings-only'.
  const isPublishableHost = (hostId: ExecutionHostId): boolean => {
    const kind = parseExecutionHostId(hostId)?.kind
    return kind === 'runtime' || (kind === 'local' && options.localHostSupported)
  }

  const laneFor = (hostId: ExecutionHostId): HostLane => {
    let lane = lanes.get(hostId)
    if (!lane) {
      lane = { revision: 0, inFlight: false, dirty: false, backoffMs: 0, retryTimer: null }
      lanes.set(hostId, lane)
    }
    return lane
  }

  const send = async (
    hostId: ExecutionHostId,
    lane: HostLane,
    workspaces: RecoveryPresentationWorkspace[]
  ): Promise<SendOutcome> => {
    if (!(await options.transport.supportsHost(hostId))) {
      return 'done'
    }
    // Why two attempts: one stale-revision answer re-bases on the host's revision and resends.
    for (let attempt = 0; attempt < 2; attempt++) {
      lane.revision += 1
      const result = await options.transport.publish(hostId, {
        clientInstanceId: options.clientInstanceId,
        clientName: options.clientName,
        clientRevision: lane.revision,
        workspaces
      })
      if (result.ok) {
        lane.revision = Math.max(lane.revision, result.acknowledgedRevision)
        return 'done'
      }
      if (result.reason === 'too-large') {
        return 'done'
      }
      if (result.reason !== 'stale-revision' || result.acknowledgedRevision === undefined) {
        return 'retry'
      }
      lane.revision = result.acknowledgedRevision
    }
    return 'retry'
  }

  const scheduleRetry = (hostId: ExecutionHostId, lane: HostLane): void => {
    lane.backoffMs =
      lane.backoffMs === 0
        ? PRESENTATION_PUBLISH_BACKOFF_MIN_MS
        : Math.min(lane.backoffMs * 2, PRESENTATION_PUBLISH_BACKOFF_MAX_MS)
    lane.retryTimer = setTimeout(() => {
      lane.retryTimer = null
      lane.dirty = true
      void drain(hostId, lane)
    }, lane.backoffMs)
  }

  // Why re-snapshot per send: a superseded or retried publish must carry current ages, not the
  // ages captured when it was first queued.
  const drain = async (
    hostId: ExecutionHostId,
    lane: HostLane,
    initial?: RecoveryPresentationWorkspace[]
  ): Promise<void> => {
    let workspaces = initial
    while (lane.dirty && !disposed) {
      lane.dirty = false
      const current = workspaces ?? options.snapshot().get(hostId) ?? []
      workspaces = undefined
      lane.inFlight = true
      let outcome: SendOutcome
      try {
        outcome = await send(hostId, lane, current)
      } catch {
        outcome = 'retry'
      } finally {
        lane.inFlight = false
      }
      if (disposed) {
        return
      }
      if (outcome === 'retry') {
        lane.dirty = false
        scheduleRetry(hostId, lane)
        return
      }
      lane.backoffMs = 0
    }
  }

  const clearTimers = (): void => {
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    if (inputTimer !== null) {
      clearTimeout(inputTimer)
      inputTimer = null
    }
  }

  const flush = (): void => {
    clearTimers()
    firstPendingChangeAt = null
    lastFlushAt = Date.now()
    const snapshot = options.snapshot()
    // Why known lanes too: a host whose last workspace closed still needs the empty full replace.
    for (const hostId of new Set([...snapshot.keys(), ...lanes.keys()])) {
      if (!isPublishableHost(hostId)) {
        continue
      }
      const lane = laneFor(hostId)
      lane.dirty = true
      if (!lane.inFlight && lane.retryTimer === null) {
        void drain(hostId, lane, snapshot.get(hostId) ?? [])
      }
    }
  }

  const viewChanged = (): void => {
    if (disposed) {
      return
    }
    const now = Date.now()
    firstPendingChangeAt ??= now
    if (trailingTimer !== null) {
      clearTimeout(trailingTimer)
    }
    const untilMaxWait = firstPendingChangeAt + PRESENTATION_PUBLISH_MAX_WAIT_MS - now
    trailingTimer = setTimeout(
      flush,
      Math.max(0, Math.min(PRESENTATION_PUBLISH_DEBOUNCE_MS, untilMaxWait))
    )
  }

  return {
    viewChanged,
    inputChanged: () => {
      if (disposed || inputTimer !== null) {
        return
      }
      const sinceFlush = lastFlushAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastFlushAt
      inputTimer = setTimeout(
        flush,
        Math.max(0, PRESENTATION_INPUT_PUBLISH_INTERVAL_MS - sinceFlush)
      )
    },
    workspaceFocusChanged: () => {
      if (disposed) {
        return
      }
      // Why: the leading edge publishes a switch at once; rapid switching then coalesces.
      if (lastFlushAt !== null && Date.now() - lastFlushAt < PRESENTATION_PUBLISH_DEBOUNCE_MS) {
        viewChanged()
        return
      }
      flush()
    },
    dispose: () => {
      disposed = true
      clearTimers()
      for (const lane of lanes.values()) {
        if (lane.retryTimer !== null) {
          clearTimeout(lane.retryTimer)
          lane.retryTimer = null
        }
      }
    }
  }
}
