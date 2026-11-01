export type NativeChatFollowUpBehavior = 'queue' | 'steer'

/** Only explicit OFF disables queueing on capable hosts. */
export function nativeChatQueueFollowUps(
  settings: { readonly nativeChatQueueFollowUps?: unknown } | null | undefined
): boolean {
  return settings?.nativeChatQueueFollowUps !== false
}

/** While the agent works on a host that queues: what a plain send does, and whether its alternate would send any differently. */
export type NativeChatSendFollowUp = { action: NativeChatFollowUpBehavior; offersChoice: boolean }

/** Read from the send's own resolver, so a waiting command or unanswerable prompts that override the choice also withdraw it. */
export function nativeChatSendFollowUp(
  sendQueues: (alternate?: true) => boolean
): NativeChatSendFollowUp {
  const queues = sendQueues()
  return { action: queues ? 'queue' : 'steer', offersChoice: queues !== sendQueues(true) }
}
