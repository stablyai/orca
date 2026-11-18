// Waits cancelled before they ended, kept on the bot so a wait's chat card can say so after a reload.
import * as z from 'zod'

export const BotCancelledWaitSchema = z.object({
  automationId: z.string().min(1).max(512),
  at: z.number()
})

export type BotCancelledWait = z.infer<typeof BotCancelledWaitSchema>

/** Never trimmed: a cancelled wait's card would read Waiting again. One small entry per cancelled wait. */
export function withBotCancelledWait(
  cancelled: readonly BotCancelledWait[] | undefined,
  wait: BotCancelledWait
): BotCancelledWait[] {
  return [...(cancelled ?? []).filter((entry) => entry.automationId !== wait.automationId), wait]
}
