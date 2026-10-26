import { z } from 'zod'

export const RewindFilePlanSchema = z.object({
  root: z.string().min(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        before: z.string().nullable(),
        after: z.string().nullable(),
        mode: z.number().int().min(0).max(0o777)
      })
    )
    .max(100)
})

export type RewindFilePlan = z.infer<typeof RewindFilePlanSchema>
export type RewindFilesPreview =
  | { available: true; fingerprint: string; files: string[] }
  | { available: false; reason: string }
export type AgentSessionRewindMode = 'conversation' | 'conversation-and-files'
