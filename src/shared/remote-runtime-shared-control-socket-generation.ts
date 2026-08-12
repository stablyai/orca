import type { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

export class SharedControlSocketGeneration {
  private current = 0

  isCurrent(generation: number): boolean {
    return generation === this.current
  }

  begin(): number {
    this.current += 1
    return this.current
  }

  invalidate(): void {
    this.current += 1
  }

  acceptClose(args: {
    generation: number
    error: RemoteRuntimeClientError
    everReady: boolean
    subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
    closeSocket: () => void
  }): boolean {
    if (!this.isCurrent(args.generation)) {
      return false
    }
    // Why: error, close, and liveness callbacks can race for one socket; only its first callback owns recovery.
    this.current += 1
    args.closeSocket()
    if (args.everReady) {
      for (const subscription of Array.from(args.subscriptions.values())) {
        try {
          subscription.callbacks.onError(args.error)
        } catch {
          // Why: one consumer callback cannot block sibling notification or reconnect scheduling.
        }
      }
    }
    return true
  }
}
