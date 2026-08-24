let subscriptionCounter = 0

export const NOTFOUND_RETRY_WINDOW_MS = 60_000

export function nextNativeChatSubscriptionId(): string {
  subscriptionCounter += 1
  return `native-chat-${subscriptionCounter}-${Date.now()}`
}
