import { z } from 'zod'

export const LIST_ARRANGEMENT_LIMITS = {
  maxBytes: 32 * 1024,
  maxSections: 16,
  maxSortKeys: 4,
  maxVars: 50
} as const

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, 'must be an identifier')
const expression = z.string().min(1).max(1024)
const factPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, 'must be a fact path such as ws.name')

export const listSectionSchema = z
  .object({
    id: identifier,
    title: z.string().min(1).max(64),
    /** A workspace lands in the first section whose rule is true. */
    when: expression.optional(),
    /** Starts collapsed until the person opens it. */
    collapsed: z.boolean().optional()
  })
  .strict()

export const listArrangementSchema = z
  .object({
    version: z.literal(1),
    facts: z.literal(1),
    vars: z
      .record(identifier, expression)
      .refine((vars) => Object.keys(vars).length <= LIST_ARRANGEMENT_LIMITS.maxVars)
      .optional(),
    sections: z.array(listSectionSchema).min(1).max(LIST_ARRANGEMENT_LIMITS.maxSections),
    /** Within a section; ties keep the person's own sort order. */
    sort: z
      .array(z.object({ by: factPath, dir: z.enum(['asc', 'desc']).optional() }).strict())
      .max(LIST_ARRANGEMENT_LIMITS.maxSortKeys)
      .optional(),
    /** Where workspaces that match no section go; defaults to the last section. */
    fallback: identifier.optional()
  })
  .strict()
  .superRefine((arrangement, ctx) => {
    const ids = arrangement.sections.map((section) => section.id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'section ids must be unique' })
    }
    if (arrangement.fallback !== undefined && !ids.includes(arrangement.fallback)) {
      ctx.addIssue({ code: 'custom', path: ['fallback'], message: 'names no section' })
    }
  })

export type ListArrangement = z.infer<typeof listArrangementSchema>
