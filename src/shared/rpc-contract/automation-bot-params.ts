// A bot automation's target and event rules, as automation.create and automation.update take them.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { AUTOMATION_EVENT_KINDS } from '../automation-event-triggers'
import { WEBHOOK_WHERE_OPS } from '../connector-webhook-contract'
import { requiredString } from './rpc-param-primitives'
import { BotAgentSetupSchema } from '../bots/bot-agent-setup'

const createResultPlaceRef = () => ({
  ref: z.string().min(1).optional(),
  label: z.string().optional()
})

export const AutomationBotTarget = lazyZodSchema(() => {
  const ResultPlaceRef = createResultPlaceRef()
  return z.object({
    botId: requiredString('Missing bot id'),
    runsIn: z.enum(['new', 'chat']),
    // No homeIfGone or toConversation: only the host sets them, when it picks the chat that made a wait.
    chat: z
      .object({ sessionId: requiredString('Missing chat id'), title: z.string().optional() })
      .optional(),
    letBotReact: z.boolean().optional(),
    agentSetup: BotAgentSetupSchema.optional(),
    resultsTo: z.union([
      z.literal('chat'),
      z.literal('none'),
      z.literal('thread'),
      // An id or key, or a link or #name the host looks up; ref and label as the host saved them.
      z.object({ channel: requiredString('Missing channel'), ...ResultPlaceRef }),
      z.object({ linearIssue: requiredString('Missing Linear issue'), ...ResultPlaceRef })
    ])
  })
})

const FilterText = lazyZodSchema(() => z.string().min(1))
const createEventTriggerFields = () => ({
  id: FilterText,
  in: z.array(FilterText).optional(),
  textContains: FilterText.optional(),
  // github.labeled only: that label.
  label: FilterText.optional(),
  // github.workflow_finished only: the one Actions run, by its id.
  run: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  subject: FilterText.optional(),
  // People by id, or a name the host looks up; absent means anyone.
  from: z.array(FilterText).optional(),
  onOwnerMessage: z.literal(true).optional(),
  // The owner's own events too; the store keeps it to github.pr_opened.
  fromOwner: z.literal(true).optional()
})

// Strict, so a filter this host can't read fails instead of widening the rule; the store checks limits.
export const AutomationEventTriggers = lazyZodSchema(() => {
  const EventTriggerFields = createEventTriggerFields()
  return z
    .array(
      z.discriminatedUnion('source', [
        z
          .object({
            ...EventTriggerFields,
            source: z.literal('slack'),
            event: z.enum(AUTOMATION_EVENT_KINDS.slack)
          })
          .strict(),
        z
          .object({
            ...EventTriggerFields,
            source: z.literal('github'),
            event: z.enum(AUTOMATION_EVENT_KINDS.github)
          })
          .strict(),
        z
          .object({
            ...EventTriggerFields,
            source: z.literal('linear'),
            event: z.enum(AUTOMATION_EVENT_KINDS.linear)
          })
          .strict(),
        // Checked on this host only; the store checks sizes and minutes.
        z
          .object({
            id: FilterText,
            source: z.literal('gmail'),
            event: z.enum(AUTOMATION_EVENT_KINDS.gmail),
            account: FilterText.optional(),
            from: z.array(FilterText).optional(),
            to: z.array(FilterText).optional(),
            subjectContains: FilterText.optional(),
            label: FilterText.optional()
          })
          .strict(),
        z
          .object({
            id: FilterText,
            source: z.literal('calendar'),
            event: z.enum(AUTOMATION_EVENT_KINDS.calendar),
            account: FilterText.optional(),
            calendar: FilterText.optional(),
            minutesBefore: z.number().int().nonnegative()
          })
          .strict(),
        // id '' and rev 0 ask the host to make the hook; the store checks paths and sizes.
        z
          .object({
            id: z.string(),
            source: z.literal('webhook'),
            event: z.enum(AUTOMATION_EVENT_KINDS.webhook),
            rev: z.number().int().nonnegative(),
            where: z
              .array(
                z
                  .object({
                    path: FilterText,
                    op: z.enum(WEBHOOK_WHERE_OPS),
                    values: z.array(z.string()).optional()
                  })
                  .strict()
              )
              .optional(),
            textContains: FilterText.optional(),
            pick: z.array(FilterText).optional(),
            subjectFrom: FilterText.optional(),
            subject: FilterText.optional()
          })
          .strict()
      ])
    )
    .optional()
})

// Strict, so a host that can't read a deadline refuses it rather than waiting forever.
export const AutomationOnceParam = lazyZodSchema(() =>
  z.object({ by: z.number().finite().positive().optional() }).strict().optional()
)
