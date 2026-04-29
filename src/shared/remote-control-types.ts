export type RemoteControlTransportMode = 'local_only' | 'relay'

export type RemoteControlCapability =
  | 'view_output'
  | 'send_input'
  | 'send_interrupt'
  | 'switch_session'
  | 'approve_action'
  | 'run_command'

export type RemoteControlPairingState = {
  pairingId: string
  issuedAt: number
  expiresAt: number
  deviceLabel: string
  transportMode: RemoteControlTransportMode
  accessToken: string
  qrPayload: string
}

export type RemoteControlSession = {
  sessionId: string
  worktreeId: string
  worktreePath: string
  branch: string
  tabId: string
  leafId: string
  title: string | null
  connected: boolean
  writable: boolean
  lastOutputAt: number | null
  preview: string
  capabilities: RemoteControlCapability[]
}

export type RemoteControlSnapshot = {
  enabled: boolean
  publishedAt: number
  transportMode: RemoteControlTransportMode
  pairing: RemoteControlPairingState | null
  sessions: RemoteControlSession[]
}

export type RemoteControlClientCommand =
  | {
      type: 'session.list'
    }
  | {
      type: 'session.focus'
      sessionId: string
    }
  | {
      type: 'session.input'
      sessionId: string
      text: string
      enter?: boolean
      interrupt?: boolean
    }
  | {
      type: 'session.approve'
      sessionId: string
      approvalId: string
      decision: 'approve' | 'deny'
    }

export type RemoteControlServerEvent =
  | {
      type: 'snapshot'
      snapshot: RemoteControlSnapshot
    }
  | {
      type: 'session.output'
      sessionId: string
      output: string
      at: number
    }
  | {
      type: 'session.exited'
      sessionId: string
      exitCode: number | null
      at: number
    }
