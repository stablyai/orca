import { decodeBrowserScreencastFrame } from '../../../../../shared/browser-screencast-protocol'
import type { RemoteBrowserStreamToken } from './remote-browser-stream-tokens'

type PendingRemoteBrowserFrame = {
  token: RemoteBrowserStreamToken
  bytes: Uint8Array<ArrayBufferLike>
}

type RemoteBrowserFramePacerDeps = {
  isCurrent: (token: RemoteBrowserStreamToken) => boolean
  renderFrame: (
    token: RemoteBrowserStreamToken,
    bytes: Uint8Array<ArrayBufferLike>,
    signal: AbortSignal
  ) => void | Promise<void>
}

export class RemoteBrowserFramePacer {
  private active: AbortController | null = null
  private pending: PendingRemoteBrowserFrame | null = null

  constructor(private readonly deps: RemoteBrowserFramePacerDeps) {}

  push(token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>): void {
    if (!this.deps.isCurrent(token) || !decodeBrowserScreencastFrame(bytes)) {
      return
    }
    this.pending = { token, bytes }
    this.drain()
  }

  clear(): void {
    this.pending = null
    this.active?.abort()
  }

  private drain(): void {
    if (this.active) {
      return
    }
    const next = this.pending
    this.pending = null
    if (!next || !this.deps.isCurrent(next.token)) {
      return
    }
    const controller = new AbortController()
    this.active = controller
    try {
      void Promise.resolve(this.deps.renderFrame(next.token, next.bytes, controller.signal))
        .catch(() => {})
        .finally(() => {
          this.active = null
          this.drain()
        })
    } catch {
      this.active = null
      this.drain()
    }
  }
}
