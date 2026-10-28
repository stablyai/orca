/**
 * The `terminal-history` blob: one moved pane's daemon history (its checkpoint, cwd and size) for
 * the destination's own daemon to cold-restore once, exactly as after an app restart. The host
 * installs it under the pane's derived session id, which the pane's first start then claims.
 */
import { z } from 'zod'
import { MAX_PANE_KEY_LEN } from '../agent-hook-listener/listener-limits'
import { PTY_SESSION_ID_SEPARATOR } from '../pty-session-id-format'
import { parsePaneKey } from '../stable-pane-id'
import { isOrcadMigrationTerminalRestoreHintCwd } from './orcad-migration-terminal-restore-hints'

export const ORCAD_MIGRATION_TERMINAL_HISTORY_VERSION = 1

/** Begins the session part of a moved pane's id (`<worktreeId>@@moved-<key>`). */
export const MOVED_PANE_HISTORY_SESSION_TAG = 'moved-'

export function isMovedPaneHistorySessionId(sessionId: string): boolean {
  const separator = sessionId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return (
    separator > 0 &&
    sessionId.startsWith(
      MOVED_PANE_HISTORY_SESSION_TAG,
      separator + PTY_SESSION_ID_SEPARATOR.length
    )
  )
}

const MAX_TERMINAL_DIMENSION = 10_000

export type OrcadMigrationTerminalHistoryDocument = {
  version: typeof ORCAD_MIGRATION_TERMINAL_HISTORY_VERSION
  paneKey: string
  /** The shell's last folder on the host; null when the source never knew it. */
  cwd: string | null
  cols: number
  rows: number
  /** The daemon's own checkpoint.json; the destination's history reader validates it on restore. */
  checkpoint: Record<string, unknown>
}

const DimensionSchema = z.number().int().min(1).max(MAX_TERMINAL_DIMENSION)

const DocumentSchema = z
  .object({
    version: z.literal(ORCAD_MIGRATION_TERMINAL_HISTORY_VERSION),
    paneKey: z
      .string()
      .refine((value) => value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null),
    cwd: z.string().refine(isOrcadMigrationTerminalRestoreHintCwd).nullable(),
    cols: DimensionSchema,
    rows: DimensionSchema,
    checkpoint: z.record(z.string(), z.unknown())
  })
  .strict()

export function parseOrcadMigrationTerminalHistoryText(
  text: string
): OrcadMigrationTerminalHistoryDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('orcad_migration_terminal_history_not_json')
  }
  const parsed = DocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('orcad_migration_terminal_history_invalid')
  }
  return parsed.data
}
