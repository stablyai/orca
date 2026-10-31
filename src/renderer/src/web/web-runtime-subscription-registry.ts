import type { WebRuntimeTransportSubscription } from './web-runtime-subscription-contract'

const REPLAYABLE_SUBSCRIPTION_METHODS = new Set(['files.watch'])

type WebRuntimeSubscriptionRegistryOptions = {
  deviceToken: string
  nextId: () => string
  sendEncrypted: (message: unknown) => boolean
}

export class WebRuntimeSubscriptionRegistry {
  readonly subscriptions = new Map<string, WebRuntimeTransportSubscription>()

  constructor(private readonly options: WebRuntimeSubscriptionRegistryOptions) {}

  close(notifySubscriptions: boolean): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    if (!notifySubscriptions) {
      return
    }
    for (const subscription of subscriptions) {
      subscription.callbacks.onClose?.()
    }
  }

  handleInterrupted(): void {
    for (const [id, subscription] of Array.from(this.subscriptions)) {
      if (!REPLAYABLE_SUBSCRIPTION_METHODS.has(subscription.method)) {
        this.subscriptions.delete(id)
        subscription.callbacks.onClose?.()
        continue
      }
      subscription.callbacks.onTransportInterrupted?.()
      if (this.subscriptions.get(subscription.id) === subscription) {
        subscription.needsReplay = true
      }
    }
  }

  replayInterrupted(): void {
    for (const subscription of Array.from(this.subscriptions.values())) {
      if (!subscription.needsReplay) {
        continue
      }
      this.subscriptions.delete(subscription.id)
      subscription.id = this.options.nextId()
      subscription.needsReplay = false
      this.subscriptions.set(subscription.id, subscription)
      if (
        this.options.sendEncrypted({
          id: subscription.id,
          deviceToken: this.options.deviceToken,
          method: subscription.method,
          params: subscription.params
        })
      ) {
        subscription.callbacks.onTransportReplayed?.()
      } else {
        subscription.needsReplay = true
      }
    }
  }

  notifyError(code: string, message: string): void {
    const subscriptions = Array.from(this.subscriptions.values())
    this.subscriptions.clear()
    for (const subscription of subscriptions) {
      subscription.callbacks.onError?.({ code, message })
    }
  }
}
