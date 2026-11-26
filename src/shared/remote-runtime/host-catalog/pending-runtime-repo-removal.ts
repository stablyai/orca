import { z } from 'zod'

const PendingRuntimeRepoRemovalSchema = z.object({
  environmentId: z.string().min(1),
  repoId: z.string().min(1),
  requestedAt: z.number().finite()
})

/** A project this desktop removed while its paired server was unreachable; `repo.rm` replays on reconnect. */
export type PendingRuntimeRepoRemoval = z.infer<typeof PendingRuntimeRepoRemovalSchema>

/** Persisted UI state is hand-editable and older builds never wrote it; keep only well-formed records. */
export function normalizePendingRuntimeRepoRemovals(value: unknown): PendingRuntimeRepoRemoval[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry: unknown) => {
    const parsed = PendingRuntimeRepoRemovalSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}
