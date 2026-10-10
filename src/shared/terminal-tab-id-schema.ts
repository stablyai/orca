import { z } from 'zod'

import { isValidTerminalTabId } from './terminal-tab-id'

/** Shared so the session schema and the tombstone value schemas validate tab ids identically.
 *  Extracted from workspace-session-schema.ts, which is at its max-lines limit. */
export const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')
