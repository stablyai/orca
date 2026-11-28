import { z } from 'zod'

import { isValidTerminalTabId } from './terminal-tab-id'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Share tab-ID validation between session and tombstone schemas. */
export const terminalTabIdSchema = lazyZodSchema(() =>
  z.string().min(1).refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')
)
