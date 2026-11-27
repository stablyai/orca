import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Counts only: a path, account or thread id would identify a machine.
const fileCount = lazyZodSchema(() => z.number().int().nonnegative().max(10_000_000))

/** What cleaning up the move's leftover Codex history copies did; once per install and version. */
export const codexHistoryCopiesCleanupSchema = lazyZodSchema(() =>
  z
    .object({
      platform: z.enum(['darwin', 'win32']),
      homes: z.number().int().nonnegative().max(1000),
      // Moved into the account's trash; deleted after a grace period and a recheck.
      files_trashed: fileCount,
      mb_trashed: fileCount,
      // Deleted from the trash.
      files_deleted: fileCount,
      mb_reclaimed: fileCount,
      // Put back from the trash: ~/.codex no longer provably held them (often compressed since).
      files_restored: fileCount,
      // Holds bytes ~/.codex lacks.
      kept_differs: fileCount,
      // A process has it open, could have without the check seeing it, or that couldn't be told.
      kept_open: fileCount,
      // Another name shares its bytes.
      kept_linked: fileCount,
      kept_missing_original: fileCount,
      // Written to between the check and the move, or in the trash.
      kept_changed: fileCount,
      kept_error: fileCount,
      // The original or the copy is compressed and the other isn't: never decoded to compare.
      kept_compressed: fileCount,
      // A Codex holds the thread's writer lock, or the locks couldn't be held.
      kept_busy: fileCount,
      // Past this launch's read budget; checked on a later launch.
      deferred: fileCount
    })
    .strict()
)
