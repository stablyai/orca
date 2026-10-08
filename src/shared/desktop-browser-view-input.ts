import { z } from 'zod'

const ratio = z.number().finite().min(0).max(1)
const modifiers = z
  .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
  .max(4)
  .default([])
const key = z.string().min(1).max(128)
const text = z.string().max(65_536)
export const DesktopBrowserViewInputSchema = z.union([
  z
    .object({
      kind: z.literal('mouse'),
      type: z.enum(['move', 'down', 'up']),
      x: ratio,
      y: ratio,
      button: z.enum(['none', 'left', 'middle', 'right']).default('none'),
      buttons: z.number().int().min(0).max(7).default(0),
      modifiers
    })
    .strict(),
  z
    .object({
      kind: z.literal('mouse'),
      type: z.literal('wheel'),
      x: ratio,
      y: ratio,
      deltaX: z.number().finite(),
      deltaY: z.number().finite(),
      buttons: z.number().int().min(0).max(7).default(0),
      modifiers
    })
    .strict(),
  z
    .object({
      kind: z.literal('key'),
      type: z.enum(['down', 'up']),
      key,
      code: key,
      text: text.optional(),
      modifiers
    })
    .strict()
    .superRefine((value, context) => {
      if (value.type === 'up' && value.text !== undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'keyup cannot carry text' })
      }
    }),
  z.object({ kind: z.literal('text'), text }).strict(),
  z.object({ kind: z.literal('composition'), text }).strict()
])
export type DesktopBrowserViewInput = z.infer<typeof DesktopBrowserViewInputSchema>
