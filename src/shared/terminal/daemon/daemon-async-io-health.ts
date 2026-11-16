export type DaemonAsyncIoHealth = {
  state: 'healthy' | 'stalled'
  pendingMs: number
}

export type DaemonAsyncIoStatus = DaemonAsyncIoHealth | { state: 'unsupported' | 'unverifiable' }
