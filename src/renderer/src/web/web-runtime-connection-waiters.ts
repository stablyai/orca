import { withRemoteRuntimeTailscaleHint } from '../../../shared/remote-runtime-tailscale-hint'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import type { WebRuntimeConnectionState } from './web-runtime-connection-frame-router'

type WebRuntimeConnectionWaiterOptions = {
  endpoint: string
  getState: () => WebRuntimeConnectionState
  isIntentionallyClosed: () => boolean
}

export class WebRuntimeConnectionWaiters {
  private readonly waiters: { resolve: () => void; reject: (error: Error) => void }[] = []

  constructor(private readonly options: WebRuntimeConnectionWaiterOptions) {}

  wait(timeoutMs = 30_000): Promise<void> {
    if (this.options.getState() === 'connected') {
      return Promise.resolve()
    }
    if (this.options.getState() === 'auth-failed') {
      return Promise.reject(createWebRuntimeUnauthorizedError())
    }
    if (this.options.isIntentionallyClosed()) {
      return Promise.reject(new Error('Remote Orca runtime connection closed.'))
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index !== -1) {
          this.waiters.splice(index, 1)
        }
        reject(
          new Error(
            withRemoteRuntimeTailscaleHint(
              'Timed out while connecting to the remote Orca runtime.',
              this.options.endpoint
            )
          )
        )
      }, timeoutMs)
      this.waiters.push({
        resolve: () => {
          window.clearTimeout(timeout)
          resolve()
        },
        reject: (error) => {
          window.clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  resolveAll(): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve()
    }
  }

  rejectUnavailable(): void {
    this.rejectAll(
      new Error(
        withRemoteRuntimeTailscaleHint(
          'Could not connect to the remote Orca runtime.',
          this.options.endpoint
        )
      )
    )
  }

  rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }
}
