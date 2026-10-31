// Preserve unknown journal union tags so newer bodies/blocks/goals/approval subjects remain readable.

import { z } from 'zod'

/** A tag a newer build could have written: a string with something other than whitespace in it. */
export function isJournalTag(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Tags a discriminated union knows, read off it so the two can never disagree. */
export function knownTags(union: z.ZodDiscriminatedUnion): ReadonlySet<string> {
  const key = union.def.discriminator
  return new Set(
    union.options.flatMap((option) => {
      const tag = option instanceof z.ZodObject ? option.shape[key] : undefined
      return tag instanceof z.ZodLiteral ? [...tag.values].map(String) : []
    })
  )
}

const fallbacks = new WeakSet<z.core.$ZodType>()

/** The arm that keeps an unknown tag; saved-outcome storage drops it, so an unknown tag refuses. */
export function isJournalOpenUnionFallback(schema: z.core.$ZodType): boolean {
  return fallbacks.has(schema)
}

/** Keep unknown nonblank tags as-is for readers to skip. Abort the catch-all for known malformed arms; blank tags are damage. */
export function openDiscriminatedUnion<T extends z.ZodDiscriminatedUnion>(known: T) {
  const key = known.def.discriminator
  const tags = knownTags(known)
  const unknown = z
    .object({ [key]: z.string().regex(/\S/) })
    .refine((value) => !tags.has(value[key] ?? ''), { abort: true })
  fallbacks.add(unknown)
  return z.union([known, unknown])
}
