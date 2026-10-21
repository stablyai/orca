// A discriminated union that reads a tag this build does not know instead of failing on it: the
// journal's blocks, goal states, approval subjects and item bodies, so a newer build can add one.

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

/** A discriminated union a tag this build does not know still reads through: kept as-is, for a
 *  reader to skip. A tag of only whitespace is damage, as an empty one is. The catch-all aborts, so
 *  a known arm's own failure still reaches the reader. */
export function openDiscriminatedUnion<T extends z.ZodDiscriminatedUnion>(known: T) {
  const key = known.def.discriminator
  const tags = knownTags(known)
  const unknown = z
    .object({ [key]: z.string().regex(/\S/) })
    .refine((value) => !tags.has(value[key] ?? ''), { abort: true })
  return z.union([known, unknown])
}
