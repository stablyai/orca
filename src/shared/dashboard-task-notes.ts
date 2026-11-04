import { z } from 'zod'

export const MAX_DASHBOARD_TASK_NOTES = 1000

export const taskNoteSchema = z.object({
  status: z.enum(['automatic', 'waiting-user', 'waiting-input', 'verified']),
  title: z.string().max(120),
  summary: z.string().max(240),
  nextStep: z.string().max(240),
  owner: z.string().max(120),
  reviewReference: z.string().max(500),
  observation: z.string().max(500),
  savedAt: z.number().finite().nonnegative()
})

export const taskNoteKeySchema = z
  .string()
  .max(4096)
  .refine((key) => {
    try {
      const tuple: unknown = JSON.parse(key)
      return (
        Array.isArray(tuple) &&
        tuple.length === 5 &&
        tuple.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 1024) &&
        ['local', 'ssh', 'wsl', 'remote'].includes(tuple[0]) &&
        JSON.stringify(tuple) === key
      )
    } catch {
      return false
    }
  }, 'Invalid dashboard task identity')

export const taskNoteMutationSchema = z.object({
  key: taskNoteKeySchema,
  note: taskNoteSchema,
  mode: z.enum(['save', 'import-if-missing']).default('save')
})

export const taskNotesSchema = z
  .record(taskNoteKeySchema, taskNoteSchema)
  .refine(
    (notes) => Object.keys(notes).length <= MAX_DASHBOARD_TASK_NOTES,
    'Too many dashboard task notes'
  )

export type DashboardTaskNote = z.infer<typeof taskNoteSchema>
export type DashboardTaskNotes = Record<string, DashboardTaskNote>
export type DashboardTaskNoteMutation = z.input<typeof taskNoteMutationSchema>
export type DashboardTaskNoteChange = { key: string; note: DashboardTaskNote }
