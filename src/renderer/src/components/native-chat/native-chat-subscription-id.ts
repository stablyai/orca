let counter = 0

export function nextNativeChatSubscriptionId(): string {
  counter += 1
  return `native-chat-${counter}-${Date.now()}`
}
