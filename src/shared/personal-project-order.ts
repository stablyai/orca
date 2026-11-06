import { z } from 'zod'

export const PERSONAL_PROJECT_ORDER_CAPABILITY = 'ui.personalProjectOrder.v1'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const ProjectPreferenceSchema = z.object({
  pinned: z.boolean().optional().catch(undefined),
  lastOpenedAt: safeInteger.optional().catch(undefined),
  openCount: safeInteger.optional().catch(undefined)
})
export type ProjectPreference = z.infer<typeof ProjectPreferenceSchema>

export const PersonalProjectOrderSchema = z.object({
  revision: safeInteger.optional().catch(undefined),
  projects: z.record(z.string(), ProjectPreferenceSchema.catch({})).catch({}),
  settledOperations: z
    .array(z.string())
    .catch([])
    .transform((operations) => operations.slice(-4096))
})
export type PersonalProjectOrder = z.infer<typeof PersonalProjectOrderSchema>

export function normalizePersonalProjectOrder(value: unknown): PersonalProjectOrder {
  const parsed = PersonalProjectOrderSchema.safeParse(value)
  return parsed.success ? parsed.data : { projects: {}, settledOperations: [] }
}

export function newerPersonalProjectOrder(
  current: PersonalProjectOrder | undefined,
  incoming: PersonalProjectOrder | undefined
): PersonalProjectOrder | undefined {
  return incoming && (incoming.revision ?? 0) >= (current?.revision ?? 0) ? incoming : current
}
