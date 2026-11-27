import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Counts only: a path, account or thread id would identify a machine.
const homeCount = lazyZodSchema(() => z.number().int().nonnegative().max(1000))

/** How far moving managed Codex homes into ~/.codex got; at most twice per install and version. */
export const codexHistoryMoveStatusSchema = lazyZodSchema(() =>
  z
    .object({
      platform: z.enum(['darwin', 'win32', 'linux']),
      homes: homeCount,
      moved: homeCount,
      // A running Codex holds a thread lock; retried every five minutes.
      stuck_busy: homeCount,
      // No lock helper can run (no perl or flock, or no PowerShell), so the home never moves.
      stuck_no_lock_helper: homeCount,
      stuck_refused: homeCount,
      stuck_incomplete: homeCount,
      stuck_failed: homeCount,
      // Moved only at their own WSL launch, so the host knows no outcome for them.
      wsl_homes: homeCount
    })
    .strict()
)
