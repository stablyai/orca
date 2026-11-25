import * as z from 'zod'
import { AutomationBotTarget, AutomationEventTriggers } from '../automation-bot-params'

export const AutomationEditPrecondition = z
  .object({
    on: z
      .array(
        z.union(
          AutomationEventTriggers.unwrap().element.options.map((rule) =>
            rule.extend({ names: z.record(z.string(), z.string()).optional() })
          )
        )
      )
      .optional(),
    bot: AutomationBotTarget.extend({
      chat: z
        .object({
          sessionId: z.string(),
          title: z.string().optional(),
          homeIfGone: z.literal(true).optional(),
          toConversation: z.literal(true).optional()
        })
        .optional()
    }).optional(),
    schedule: z
      .object({
        rrule: z.string(),
        dtstart: z.number(),
        timezone: z.string(),
        timezoneExplicit: z.boolean().optional()
      })
      .optional()
  })
  .optional()
