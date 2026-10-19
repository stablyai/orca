/**
 * The `editor-drafts` blob: unsaved editor buffers shed from the signed manifest so it stays under
 * its size cap. The manifest declares the blob's digest and exactly which editor entries it fills
 * (`dormantState.editorDraftsBlob`); those entries carry no inline `dirtyDraftContent`.
 */
import { z } from 'zod'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from './orcad-migration-blob-transfer'
import {
  MAX_ORCAD_MIGRATION_DORMANT_ROWS,
  assertUnique,
  requiredRecord,
  requiredString
} from './orcad-migration-dormant-value-validation'
import { OrcadMigrationDigestSchema } from './orcad-migration-scrollback'

export const ORCAD_MIGRATION_EDITOR_DRAFTS_VERSION = 1
export const ORCAD_MIGRATION_EDITOR_DRAFTS_KEY = 'drafts'
export const MAX_ORCAD_MIGRATION_EDITOR_DRAFTS_BYTES =
  ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['editor-drafts'].maxBytes

/** One `openFilesByWorktree[worktreeKey]` entry, by its `filePath`. */
export type OrcadMigrationEditorDraftEntry = { worktreeKey: string; filePath: string }

export type OrcadMigrationEditorDraftsDeclaration = {
  sha256: string
  byteLength: number
  entries: OrcadMigrationEditorDraftEntry[]
}

export type OrcadMigrationEditorDraft = OrcadMigrationEditorDraftEntry & { content: string }

export type OrcadMigrationEditorDraftsDocument = {
  version: typeof ORCAD_MIGRATION_EDITOR_DRAFTS_VERSION
  drafts: OrcadMigrationEditorDraft[]
}

export function orcadMigrationEditorDraftIdentity(entry: OrcadMigrationEditorDraftEntry): string {
  return `${entry.worktreeKey}\0${entry.filePath}`
}

export function parseOrcadMigrationEditorDraftsDeclaration(
  value: unknown
): OrcadMigrationEditorDraftsDeclaration {
  const record = requiredRecord(value, 'orcad_migration_editor_drafts_declaration_invalid')
  const sha256 = OrcadMigrationDigestSchema.safeParse(record.sha256)
  if (
    !sha256.success ||
    !Number.isSafeInteger(record.byteLength) ||
    Number(record.byteLength) < 1 ||
    Number(record.byteLength) > MAX_ORCAD_MIGRATION_EDITOR_DRAFTS_BYTES ||
    !Array.isArray(record.entries) ||
    record.entries.length === 0 ||
    record.entries.length > MAX_ORCAD_MIGRATION_DORMANT_ROWS
  ) {
    throw new Error('orcad_migration_editor_drafts_declaration_invalid')
  }
  const entries = record.entries.map((entry) => {
    const item = requiredRecord(entry, 'orcad_migration_editor_drafts_declaration_invalid')
    return {
      worktreeKey: requiredString(
        item.worktreeKey,
        'orcad_migration_editor_drafts_declaration_invalid'
      ),
      filePath: requiredString(item.filePath, 'orcad_migration_editor_drafts_declaration_invalid')
    }
  })
  assertUnique(entries, orcadMigrationEditorDraftIdentity, 'editor_drafts_entry')
  return { sha256: sha256.data, byteLength: Number(record.byteLength), entries }
}

/** Each declared entry names exactly one session editor entry, and that entry has no inline draft. */
export function assertOrcadMigrationEditorDraftsDeclarationReferences(
  session: WorkspaceSessionState | undefined,
  declaration: OrcadMigrationEditorDraftsDeclaration
): void {
  for (const entry of declaration.entries) {
    const matches = (session?.openFilesByWorktree?.[entry.worktreeKey] ?? []).filter(
      (file) => file.filePath === entry.filePath
    )
    if (matches.length !== 1 || matches[0].dirtyDraftContent !== undefined) {
      throw new Error('orcad_migration_editor_drafts_declaration_scope_invalid')
    }
  }
}

// Not strict: a same-version sender may add optional fields this build ignores.
const EditorDraftsDocumentSchema = z.object({
  version: z.literal(ORCAD_MIGRATION_EDITOR_DRAFTS_VERSION),
  drafts: z
    .array(
      z.object({
        worktreeKey: z.string().min(1),
        filePath: z.string().min(1),
        content: z.string()
      })
    )
    .max(MAX_ORCAD_MIGRATION_DORMANT_ROWS)
})

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** The blob's bytes, held to an exact one-to-one match with the declared entries. */
export function parseOrcadMigrationEditorDraftsBytes(
  bytes: Uint8Array,
  declaration: OrcadMigrationEditorDraftsDeclaration
): OrcadMigrationEditorDraft[] {
  let value: unknown
  try {
    value = JSON.parse(UTF8.decode(bytes))
  } catch {
    throw new Error('orcad_migration_editor_drafts_not_json')
  }
  const parsed = EditorDraftsDocumentSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('orcad_migration_editor_drafts_invalid')
  }
  const drafts = parsed.data.drafts.map((draft) => ({
    worktreeKey: draft.worktreeKey,
    filePath: draft.filePath,
    content: draft.content
  }))
  assertUnique(drafts, orcadMigrationEditorDraftIdentity, 'editor_drafts_entry')
  const declared = new Set(declaration.entries.map(orcadMigrationEditorDraftIdentity))
  if (
    drafts.length !== declared.size ||
    drafts.some((draft) => !declared.has(orcadMigrationEditorDraftIdentity(draft)))
  ) {
    throw new Error('orcad_migration_editor_drafts_set_mismatch')
  }
  return drafts
}
