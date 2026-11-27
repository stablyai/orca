// Mirror of the trigger event in cloud/packages/connector-contract/src/{trigger,delivery}-messages.ts.
import * as z from 'zod'
import { WebhookTriggerEvent, hookIdOfActor, hookIdOfRule } from './connector-webhook-contract'

const SourceTriggerEvent = z.object({
  key: z.string().min(1),
  // A person, never a hook.
  actorId: z
    .string()
    .min(1)
    .refine((id) => hookIdOfActor(id) === null),
  fromOwner: z.literal(true).optional(),
  onOwnerMessage: z.literal(true).optional(),
  // A pull request that was opened, by its head; no run reads it.
  pr: z
    .object({
      repoId: z.string().regex(/^\d{1,32}$/),
      number: z.number().int().positive(),
      headRef: z.string().min(1),
      headSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
      headRepoId: z
        .string()
        .regex(/^\d{1,32}$/)
        .optional()
    })
    .optional(),
  subject: z.string().min(1).optional(),
  occurredAt: z.number().int().nonnegative(),
  actor: z.string().min(1).optional(),
  place: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  text: z.string().optional(),
  webhook: z.never().optional()
})

/** What a trigger delivery says happened: a source's event, or a hook's call. */
export const ConnectorTriggerEvent = z.union([SourceTriggerEvent, WebhookTriggerEvent])

/** A bot automation a message its bot answers also matches, which runs in the bot's turn. Unreadable,
 *  the turn runs without it, as on a machine that doesn't list triggerInTurn. */
export const ConnectorTurnAutomation = z.object({
  automationId: z.string().min(1),
  triggerId: z.string().min(1),
  botId: z.string().min(1),
  event: SourceTriggerEvent
})
export type ConnectorTurnAutomation = z.infer<typeof ConnectorTurnAutomation>

// A hook's call comes only in a webhook conversation, from the hook its rule names; no other event
// carries call fields or names a hook's rule.
export function isTriggerFromItsSource(delivery: {
  conversation: { source: string }
  triggerId: string
  event: { actorId: string; webhook?: unknown }
}): boolean {
  return delivery.conversation.source === 'webhook'
    ? delivery.event.webhook !== undefined &&
        hookIdOfActor(delivery.event.actorId) === hookIdOfRule(delivery.triggerId)
    : delivery.event.webhook === undefined && hookIdOfRule(delivery.triggerId) === null
}
