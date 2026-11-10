// Per-turn file checkpoints for "Rewind to here": preview, restore and undo.

import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'
import { AGENT_SESSION_CHECKPOINT_UNDO_ID } from '../agent-session/lifecycle/agent-session-checkpoint'

export const CheckpointItemParams = OptionsParams.extend({
  itemId: z.string().min(1).max(4096)
}).strict()

export const CheckpointUndoParams = OptionsParams.extend({
  undoId: z.string().regex(AGENT_SESSION_CHECKPOINT_UNDO_ID)
}).strict()
