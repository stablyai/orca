/**
 * The `terminal-restore-hints` blob: each moved pane's last working directory on the source, so
 * the destination reopens it there instead of at the worktree root. One JSON document per
 * migration; a later format is a new capability, never a silent reinterpretation of this one.
 */
import { z } from 'zod'
import { MAX_PANE_KEY_LEN } from './agent-hook-listener/listener-limits'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from './orcad-migration-blob-transfer'
import { parsePaneKey } from './stable-pane-id'

export const ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION = 1
export const ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY = 'migration'
export const MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS = 8192
// Linux PATH_MAX; a longer cwd cannot be a directory a shell could have been in.
export const MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINT_CWD_LENGTH = 4096
export const MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES =
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['terminal-restore-hints'].maxBytes

export type OrcadMigrationTerminalRestoreHint = { paneKey: string; cwd: string }

export type OrcadMigrationTerminalRestoreHintsDocument = {
  version: typeof ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION
  hints: OrcadMigrationTerminalRestoreHint[]
}

export function isOrcadMigrationTerminalRestoreHintPaneKey(value: string): boolean {
  return value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null
}

/** Absolute POSIX; `//` is refused because a UNC-style spelling never names a distro path. */
export function isOrcadMigrationTerminalRestoreHintCwd(value: string): boolean {
  return (
    value.length <= MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINT_CWD_LENGTH &&
    /^\/(?!\/)/.test(value) &&
    !value.includes('\0')
  )
}

const HintSchema = z.object({
  paneKey: z.string().refine(isOrcadMigrationTerminalRestoreHintPaneKey, {
    message: 'orcad_migration_terminal_restore_hint_pane_key_invalid'
  }),
  cwd: z.string().refine(isOrcadMigrationTerminalRestoreHintCwd, {
    message: 'orcad_migration_terminal_restore_hint_cwd_invalid'
  })
})

// Not strict: a same-version sender may add optional fields this build ignores.
export const OrcadMigrationTerminalRestoreHintsDocumentSchema = z
  .object({
    version: z.literal(ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION),
    hints: z.array(HintSchema).max(MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS)
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const hint of value.hints) {
      if (seen.has(hint.paneKey)) {
        context.addIssue({
          code: 'custom',
          message: 'orcad_migration_terminal_restore_hint_duplicate'
        })
        return
      }
      seen.add(hint.paneKey)
    }
  })

export function parseOrcadMigrationTerminalRestoreHintsDocument(
  value: unknown
): OrcadMigrationTerminalRestoreHintsDocument {
  const parsed = OrcadMigrationTerminalRestoreHintsDocumentSchema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? ''
    // Zod's own messages (wrong version, missing field) collapse into one stable code.
    throw new Error(
      message.startsWith('orcad_migration_terminal_restore_')
        ? message
        : 'orcad_migration_terminal_restore_hints_invalid'
    )
  }
  return {
    version: parsed.data.version,
    hints: parsed.data.hints.map((hint) => ({ paneKey: hint.paneKey, cwd: hint.cwd }))
  }
}

/** The blob's UTF-8 JSON text, size-checked before it is parsed. */
export function parseOrcadMigrationTerminalRestoreHintsText(
  text: string
): OrcadMigrationTerminalRestoreHintsDocument {
  if (text.length > MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES) {
    throw new Error('orcad_migration_terminal_restore_hints_too_large')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('orcad_migration_terminal_restore_hints_not_json')
  }
  return parseOrcadMigrationTerminalRestoreHintsDocument(value)
}
