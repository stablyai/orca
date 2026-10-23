export type StalledDaemonOwner = {
  protocolVersion: number
  pid: number
  startedAtMs: number
  launchNonce: string
}

export type StalledDaemonSession = {
  sessionId: string
  incarnationId: string
  cwd: string | null
  pid: number | null
}

export type StalledDaemonReview =
  | { status: 'ready'; owner: StalledDaemonOwner; sessions: StalledDaemonSession[] }
  | { status: 'refused' }

export type StalledDaemonRestartRequest = {
  owner: StalledDaemonOwner
  sessions: StalledDaemonSession[]
}

export type StalledDaemonRestartResult =
  | { status: 'restarted'; killedCount: number }
  | { status: 'refused' }

export type DaemonAsyncIoHealth = {
  state: 'healthy' | 'stalled'
  pendingMs: number
  recoverySupported?: boolean
  owner?: StalledDaemonOwner
}

export type DaemonAsyncIoStatus = DaemonAsyncIoHealth | { state: 'unsupported' | 'unverifiable' }
