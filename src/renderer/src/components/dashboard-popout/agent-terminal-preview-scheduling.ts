import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'

export type TerminalPreviewLivePayload = Extract<TerminalPreviewDataPayload, { type: 'data' }>

const connectionConsumersByPtyId = new Map<string, number>()
const pendingConnectionReleasesByPtyId = new Map<string, symbol>()
const pendingConnectionsByPtyId = new Map<string, Promise<TerminalPreviewConnectResult>>()
type PreviewMountJob = { cancelled: boolean; mount: () => void }
const previewMountQueue: PreviewMountJob[] = []
let previewMountFrame: number | null = null
const readyPreviewFlushes = new Set<() => void>()
let previewFlushFrame: number | null = null

function scheduleNextPreviewMount(): void {
  if (previewMountFrame !== null || previewMountQueue.length === 0) {
    return
  }
  previewMountFrame = requestAnimationFrame(() => {
    previewMountFrame = null
    let job = previewMountQueue.shift()
    while (job?.cancelled) {
      job = previewMountQueue.shift()
    }
    job?.mount()
    scheduleNextPreviewMount()
  })
}

export function scheduleAgentTerminalPreviewFrameTask(task: () => void): () => void {
  const job = { cancelled: false, mount: task }
  previewMountQueue.push(job)
  scheduleNextPreviewMount()
  return () => {
    job.cancelled = true
  }
}

function scheduleNextPreviewFlush(): void {
  if (previewFlushFrame !== null || readyPreviewFlushes.size === 0) {
    return
  }
  previewFlushFrame = requestAnimationFrame(() => {
    previewFlushFrame = null
    const next = readyPreviewFlushes.values().next().value
    if (next) {
      readyPreviewFlushes.delete(next)
      next()
    }
    scheduleNextPreviewFlush()
  })
}

function scheduleAgentTerminalPreviewFlush(task: () => void): () => void {
  readyPreviewFlushes.add(task)
  scheduleNextPreviewFlush()
  return () => {
    readyPreviewFlushes.delete(task)
  }
}

export function retainAgentTerminalPreviewConnection(ptyId: string): () => void {
  pendingConnectionReleasesByPtyId.delete(ptyId)
  connectionConsumersByPtyId.set(ptyId, (connectionConsumersByPtyId.get(ptyId) ?? 0) + 1)
  let retained = true
  return () => {
    if (!retained) {
      return
    }
    retained = false
    const remaining = (connectionConsumersByPtyId.get(ptyId) ?? 1) - 1
    if (remaining > 0) {
      connectionConsumersByPtyId.set(ptyId, remaining)
      return
    }
    connectionConsumersByPtyId.delete(ptyId)
    const release = Symbol(ptyId)
    pendingConnectionReleasesByPtyId.set(ptyId, release)
    queueMicrotask(() => {
      if (
        pendingConnectionReleasesByPtyId.get(ptyId) !== release ||
        connectionConsumersByPtyId.has(ptyId)
      ) {
        return
      }
      pendingConnectionReleasesByPtyId.delete(ptyId)
      void window.api.terminalPreview.unsubscribe(ptyId)
    })
  }
}

export function connectAgentTerminalPreview(
  ptyId: string,
  options: { scrollbackRows?: number }
): Promise<TerminalPreviewConnectResult> {
  const pending = pendingConnectionsByPtyId.get(ptyId)
  if (pending) {
    return pending
  }
  const connection = window.api.terminalPreview.connect(ptyId, options)
  pendingConnectionsByPtyId.set(ptyId, connection)
  void connection.then(
    () => {
      if (pendingConnectionsByPtyId.get(ptyId) === connection) {
        pendingConnectionsByPtyId.delete(ptyId)
      }
    },
    () => {
      if (pendingConnectionsByPtyId.get(ptyId) === connection) {
        pendingConnectionsByPtyId.delete(ptyId)
      }
    }
  )
  return connection
}

export function createPassiveAgentTerminalLiveQueue(args: {
  ptyId: string
  intervalMs: number
  isDisposed: () => boolean
  write: (payload: TerminalPreviewLivePayload) => Promise<void>
}): {
  write: (payload: TerminalPreviewLivePayload) => Promise<void>
  release: () => void
} {
  const pending: { payload: TerminalPreviewLivePayload; resolve: () => void }[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelFlush: (() => void) | null = null
  const releasePending = (): void => {
    for (const item of pending.splice(0)) {
      item.resolve()
    }
  }
  const release = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    cancelFlush?.()
    cancelFlush = null
    releasePending()
  }
  const flush = (): void => {
    cancelFlush = null
    const batch = pending.splice(0)
    if (batch.length === 0 || args.isDisposed()) {
      for (const item of batch) {
        item.resolve()
      }
      return
    }
    void args
      .write({
        type: 'data',
        ptyId: args.ptyId,
        data: batch.map((item) => item.payload.data).join(''),
        bytes: batch.reduce((total, item) => total + item.payload.bytes, 0)
      })
      .then(() => {
        for (const item of batch) {
          item.resolve()
        }
      })
  }
  return {
    write: (payload) =>
      new Promise<void>((resolve) => {
        pending.push({ payload, resolve })
        if (!timer && !cancelFlush) {
          timer = setTimeout(() => {
            timer = null
            cancelFlush = scheduleAgentTerminalPreviewFlush(flush)
          }, args.intervalMs)
        }
      }),
    release
  }
}

export function createAgentTerminalPreviewResizeScheduler(args: {
  passive: boolean
  settleMs: number
  scheduleFit: () => void
  scheduleGrid: () => void
}): { schedule: () => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    schedule: () => {
      if (args.passive) {
        if (timer) {
          clearTimeout(timer)
        }
        timer = setTimeout(() => {
          timer = null
          args.scheduleFit()
        }, args.settleMs)
      } else {
        args.scheduleFit()
      }
      args.scheduleGrid()
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
