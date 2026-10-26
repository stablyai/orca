import { z } from 'zod'

import { isValidTerminalTabId } from './terminal-tab-id'

/** Share tab-ID validation between session and tombstone schemas. */
export const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')
