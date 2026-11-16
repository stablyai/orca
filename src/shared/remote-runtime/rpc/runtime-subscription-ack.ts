/** Streams whose frames the desktop renderer acknowledges, so main can bound what it has sent. */
export const RUNTIME_ACKED_SUBSCRIPTION_METHODS: ReadonlySet<string> = new Set([
  'agentSession.subscribe'
])
export const RUNTIME_SUBSCRIPTION_ACK_CHANNEL = 'runtime:subscriptionAck'
/** Acked by count, not a timer alone: a hidden window's timers are throttled to seconds. */
export const RUNTIME_SUBSCRIPTION_ACK_EVERY_FRAMES = 4
export const RUNTIME_SUBSCRIPTION_ACK_DELAY_MS = 100

export type RuntimeSubscriptionAck = { subscriptionId: string; processedFrames: number }
