import * as z from 'zod'

// A turn row's record of what it took in: the runs whose finish woke it, and each background run its
// root agent launched with the inputs it had taken by then.

const RunId = z.string().min(1).max(512)

export const TurnInputFields = {
  wokenBy: z.array(RunId).min(1).max(16).optional(),
  launches: z
    .array(z.object({ run: RunId, sends: z.array(RunId).max(16), runs: z.array(RunId).max(16) }))
    .min(1)
    .max(16)
    .optional()
}
