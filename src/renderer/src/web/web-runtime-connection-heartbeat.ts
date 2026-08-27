import { installWindowVisibilityInterval } from '../lib/window-visibility-interval'

const HEARTBEAT_INTERVAL_MS = 10_000
const HEARTBEAT_IDLE_MS = 25_000
const HEARTBEAT_PROBE_GRACE_MS = 20_000

type WebRuntimeConnectionHeartbeatOptions = {
  now: () => number
  isDocumentVisible: () => boolean
  isConnected: () => boolean
  getSocket: () => WebSocket | null
  sendProbe: () => boolean
  handleDeadSocket: (socket: WebSocket) => void
}

export class WebRuntimeConnectionHeartbeat {
  lastInboundFrameAt = 0
  heartbeatProbeSentAt: number | null = null
  lastHeartbeatTickAt = 0
  private cleanup: (() => void) | null = null

  constructor(private readonly options: WebRuntimeConnectionHeartbeatOptions) {}

  noteInboundFrame(): void {
    this.lastInboundFrameAt = this.options.now()
    this.heartbeatProbeSentAt = null
  }

  start(): void {
    this.clear()
    const now = this.options.now()
    this.lastInboundFrameAt = now
    this.lastHeartbeatTickAt = now
    this.heartbeatProbeSentAt = null
    this.cleanup = installWindowVisibilityInterval({
      run: () => this.runTick(),
      runOnVisible: () => this.rebaseline(),
      intervalMs: HEARTBEAT_INTERVAL_MS
    })
  }

  clear(): void {
    this.cleanup?.()
    this.cleanup = null
    this.heartbeatProbeSentAt = null
  }

  runTick(): void {
    const now = this.options.now()
    const sinceLastTick = now - this.lastHeartbeatTickAt
    this.lastHeartbeatTickAt = now
    if (sinceLastTick >= HEARTBEAT_INTERVAL_MS * 2) {
      this.lastInboundFrameAt = now
      this.heartbeatProbeSentAt = null
    }
    if (!this.options.isDocumentVisible()) {
      return
    }
    const socket = this.options.getSocket()
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.options.isConnected()) {
      return
    }
    if (
      this.heartbeatProbeSentAt !== null &&
      now - this.heartbeatProbeSentAt >= HEARTBEAT_PROBE_GRACE_MS
    ) {
      socket.close()
      this.options.handleDeadSocket(socket)
      return
    }
    if (this.heartbeatProbeSentAt === null && now - this.lastInboundFrameAt >= HEARTBEAT_IDLE_MS) {
      if (this.options.sendProbe()) {
        this.heartbeatProbeSentAt = now
      }
    }
  }

  private rebaseline(): void {
    this.lastHeartbeatTickAt = this.options.now()
    this.heartbeatProbeSentAt = null
  }
}
