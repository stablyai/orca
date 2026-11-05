import { z } from 'zod'

export const WorktreeSelector = z.object({
  worktree: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing worktree selector'))
})

// Why: optional so older hosts ignore it and older clients keep the legacy trailing batch window;
// unknown future values fall back to legacy instead of rejecting the subscription.
export const FileWatch = WorktreeSelector.extend({
  batchCadence: z.enum(['interval']).optional().catch(undefined)
})

export type FileWatchBatchCadence = NonNullable<z.infer<typeof FileWatch>['batchCadence']>

export const FileOpen = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing relative path'))
})
