import { z } from 'zod'
import { WorktreeTabSelector } from './session-tabs-schemas-params'

// Why pinned here: the ref is a file name on the host, so no other shape may reach the read.
export const TERMINAL_SCROLLBACK_SNAPSHOT_REF_PATTERN = /^v1-[0-9a-f]{32}$/

export const SessionReadTerminalScrollbackParams = WorktreeTabSelector.extend({
  ref: z.string().regex(TERMINAL_SCROLLBACK_SNAPSHOT_REF_PATTERN, 'Invalid scrollback ref')
})

export type SessionReadTerminalScrollbackResult = { buffer: string }
