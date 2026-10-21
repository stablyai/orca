import { z } from 'zod'
import type { ExecutionHostId } from './execution-host'
import { executionHostIdSchema } from './execution-host-id-schema'

/** Two worktrees shown side by side; whichever one is `activeWorktreeId` owns input. */
export type WorktreeSplitViewPair = {
  leftWorktreeId: string
  leftExecutionHostId: ExecutionHostId | null
  rightWorktreeId: string
  rightExecutionHostId: ExecutionHostId | null
}

export const worktreeSplitViewPairSchema = z
  .object({
    leftWorktreeId: z.string(),
    leftExecutionHostId: executionHostIdSchema.nullable(),
    rightWorktreeId: z.string(),
    rightExecutionHostId: executionHostIdSchema.nullable()
  })
  .nullable()

/** The persisted pair when it can still be shown beside `activeWorktreeId`, else null. */
export function restorableWorktreeSplitViewPair(
  pair: WorktreeSplitViewPair | null | undefined,
  activeWorktreeId: string | null,
  validWorktreeIds: ReadonlySet<string>
): WorktreeSplitViewPair | null {
  if (
    !pair ||
    pair.leftWorktreeId === pair.rightWorktreeId ||
    !validWorktreeIds.has(pair.leftWorktreeId) ||
    !validWorktreeIds.has(pair.rightWorktreeId) ||
    (activeWorktreeId !== pair.leftWorktreeId && activeWorktreeId !== pair.rightWorktreeId)
  ) {
    return null
  }
  return pair
}
