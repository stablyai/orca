import * as z from 'zod'
import { requiredString } from '../rpc-param-primitives'
import { isTerminalLeafMoveRequest } from '../../workspace-layout/terminal-topology/terminal-leaf-move'

/** Moves a renderer-owned leaf into a newly named tab before the renderer mounts it. */
export const TerminalMoveLeaf = z
  .object({
    worktreeId: requiredString('Missing worktree id').pipe(z.string().max(512)),
    sourceTabId: requiredString('Missing source tab id').pipe(z.string().max(512)),
    targetTabId: requiredString('Missing target tab id').pipe(z.string().max(512)),
    leafId: requiredString('Missing leaf id').pipe(z.string().max(512)),
    ptyId: z.string().min(1).max(512).nullable()
  })
  .refine(isTerminalLeafMoveRequest, { message: 'Invalid terminal pane identity' })
