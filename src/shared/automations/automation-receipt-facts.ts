import { z } from 'zod'
import type { Automation } from './automation-definition'
import type { AutomationEventTrigger } from '../automation-event-triggers'
import { getUtf8ByteLength } from '../text/utf8-byte-limits'

const accountScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host-only') }),
  z.object({ kind: z.literal('named'), value: z.string().min(1).max(200) })
])

const triggerExtra = z.object({
  triggerId: z.string().min(1).max(128),
  additionalConditions: z.enum(['none', 'present', 'unknown']),
  google: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('gmail'), account: accountScope }),
      z.object({
        kind: z.literal('calendar'),
        minutesBefore: z.number().int().min(0).max(1440),
        account: accountScope,
        calendar: z.enum(['primary', 'other'])
      })
    ])
    .optional()
})

const facts = z.union([
  z.object({ version: z.literal(1), unavailable: z.literal('item-budget') }),
  z.object({
    version: z.literal(1),
    automationCreatedAt: z.number().finite(),
    zone: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('effective-at-save'), iana: z.string().min(1).max(128) }),
      z.object({ kind: z.literal('not-recorded') })
    ]),
    triggerExtras: z.object({
      coverage: z.enum(['complete', 'partial']),
      items: z.array(triggerExtra).max(20)
    })
  })
])

export type AutomationReceiptFacts = z.infer<typeof facts>
export type AutomationReceiptTriggerExtra = z.infer<typeof triggerExtra>
export const AUTOMATION_RECEIPT_FACTS_MAX_BYTES = 8 * 1024

export function readAutomationReceiptFacts(
  value: unknown,
  supportsGoogleTriggers = true
): AutomationReceiptFacts | undefined {
  if (!supportsGoogleTriggers) {
    return undefined
  }
  try {
    if (
      getUtf8ByteLength(JSON.stringify({ receiptFacts: value })) >
      AUTOMATION_RECEIPT_FACTS_MAX_BYTES
    ) {
      return undefined
    }
  } catch {
    return undefined
  }
  const parsed = facts.safeParse(value)
  if (
    parsed.success &&
    !('unavailable' in parsed.data) &&
    new Set(parsed.data.triggerExtras.items.map((extra) => extra.triggerId)).size !==
      parsed.data.triggerExtras.items.length
  ) {
    return undefined
  }
  return parsed.success &&
    getUtf8ByteLength(JSON.stringify({ receiptFacts: parsed.data })) <=
      AUTOMATION_RECEIPT_FACTS_MAX_BYTES
    ? parsed.data
    : undefined
}

// A future or damaged extension cannot make the historical receipt unreadable.
export const storedAutomationReceiptFacts = z.unknown().optional()

function extraFor(trigger: AutomationEventTrigger): AutomationReceiptTriggerExtra | null {
  let additionalConditions: 'none' | 'present' = 'none'
  if (
    ('from' in trigger && trigger.from?.length) ||
    ('to' in trigger && trigger.to?.length) ||
    ('subjectContains' in trigger && trigger.subjectContains) ||
    ('textContains' in trigger && trigger.textContains) ||
    ('label' in trigger && trigger.label) ||
    ('run' in trigger && trigger.run) ||
    ('onOwnerMessage' in trigger && trigger.onOwnerMessage) ||
    ('fromOwner' in trigger && trigger.fromOwner) ||
    ('where' in trigger && trigger.where?.length)
  ) {
    additionalConditions = 'present'
  }
  const extra = {
    triggerId: trigger.id,
    additionalConditions,
    ...(trigger.source === 'gmail' || trigger.source === 'calendar'
      ? {
          google: {
            kind: trigger.source,
            account: trigger.account
              ? { kind: 'named' as const, value: trigger.account }
              : { kind: 'host-only' as const },
            ...(trigger.source === 'calendar'
              ? {
                  minutesBefore: trigger.minutesBefore,
                  calendar: trigger.calendar ? ('other' as const) : ('primary' as const)
                }
              : {})
          }
        }
      : {})
  }
  const parsed = triggerExtra.safeParse(extra)
  return parsed.success ? parsed.data : null
}

export function automationReceiptFacts(
  automation: Pick<Automation, 'createdAt' | 'on'>,
  effectiveZone?: string
): AutomationReceiptFacts {
  const result: AutomationReceiptFacts = {
    version: 1,
    automationCreatedAt: automation.createdAt,
    zone: effectiveZone
      ? { kind: 'effective-at-save', iana: effectiveZone }
      : { kind: 'not-recorded' },
    triggerExtras: { coverage: 'complete', items: [] }
  }
  for (const trigger of [...(automation.on ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )) {
    const extra = extraFor(trigger)
    if (!extra || result.triggerExtras.items.some((item) => item.triggerId === extra.triggerId)) {
      result.triggerExtras.coverage = 'partial'
      continue
    }
    result.triggerExtras.items.push(extra)
    if (!readAutomationReceiptFacts(result)) {
      result.triggerExtras.items.pop()
      result.triggerExtras.coverage = 'partial'
    }
  }
  return readAutomationReceiptFacts(result) ?? { version: 1, unavailable: 'item-budget' }
}
