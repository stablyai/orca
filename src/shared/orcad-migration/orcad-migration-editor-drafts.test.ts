import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import {
  parseOrcadMigrationEditorDraftsBytes,
  type OrcadMigrationEditorDraftsDeclaration
} from './orcad-migration-editor-drafts'
import { serializeOrcadMigrationValue } from './orcad-migration-manifest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from './orcad-migration-manifest-validation'

const WORKTREE = 'repo-1::/srv/repo-1-wt'
const FILE_A = '/srv/repo-1-wt/a.ts'
const FILE_B = '/srv/repo-1-wt/b.ts'

function file(filePath: string, dirtyDraftContent?: string): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/srv/repo-1-wt/'.length),
    worktreeId: WORKTREE,
    language: 'typescript',
    ...(dirtyDraftContent === undefined ? {} : { dirtyDraftContent })
  }
}

const declaration: OrcadMigrationEditorDraftsDeclaration = {
  sha256: 'c'.repeat(64),
  byteLength: 120,
  entries: [{ worktreeKey: WORKTREE, filePath: FILE_A }]
}

function rawManifest(editorDraftsBlob: unknown, files = [file(FILE_A), file(FILE_B, 'inline')]) {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-drafts',
    createdAt: '2026-10-01T12:00:00.000Z',
    source: { sshTargetId: 'target', sshTargetGeneration: 3, targetLabel: 'Host' },
    payload: {
      repositories: [
        {
          id: 'repo-1',
          path: '/srv/repo-1',
          displayName: 'Repo',
          badgeColor: '#737373',
          addedAt: 1
        }
      ],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        workspaceSession: {
          ...getDefaultWorkspaceSession(),
          openFilesByWorktree: { [WORKTREE]: files }
        },
        ...(editorDraftsBlob === undefined ? {} : { editorDraftsBlob })
      }
    },
    manifestSha256: 'a'.repeat(64)
  }
}

describe('orcad migration editor drafts', () => {
  it('keeps the signed declaration in its golden wire shape', () => {
    const parsed = parseOrcadMigrationManifest(rawManifest(declaration))
    expect(
      serializeOrcadMigrationValue(parsed.payload.dormantState?.editorDraftsBlob)
    ).toMatchInlineSnapshot(
      `"{"byteLength":120,"entries":[{"filePath":"/srv/repo-1-wt/a.ts","worktreeKey":"repo-1::/srv/repo-1-wt"}],"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}"`
    )
  })

  it('stays optional: a manifest without it parses as before', () => {
    const parsed = parseOrcadMigrationManifest(rawManifest(undefined))
    expect(parsed.payload.dormantState).not.toHaveProperty('editorDraftsBlob')
  })

  it('names only shed editor entries, each exactly once', () => {
    const scope = 'orcad_migration_editor_drafts_declaration_scope_invalid'
    const entry = (filePath: string, worktreeKey = WORKTREE) => ({
      ...declaration,
      entries: [{ worktreeKey, filePath }]
    })
    // An entry that still carries its draft inline.
    expect(() => parseOrcadMigrationManifest(rawManifest(entry(FILE_B)))).toThrow(scope)
    expect(() => parseOrcadMigrationManifest(rawManifest(entry('/srv/repo-1-wt/none.ts')))).toThrow(
      scope
    )
    expect(() =>
      parseOrcadMigrationManifest(rawManifest(entry(FILE_A, 'repo-1::/srv/other')))
    ).toThrow(scope)
    expect(() =>
      parseOrcadMigrationManifest(rawManifest(declaration, [file(FILE_A), file(FILE_A)]))
    ).toThrow(scope)
    expect(() =>
      parseOrcadMigrationManifest(
        rawManifest({ ...declaration, entries: [...declaration.entries, ...declaration.entries] })
      )
    ).toThrow('orcad_migration_dormant_editor_drafts_entry_duplicate')
  })

  it('refuses a malformed declaration', () => {
    const invalid = 'orcad_migration_editor_drafts_declaration_invalid'
    for (const value of [
      { ...declaration, entries: [] },
      { ...declaration, sha256: 'not-a-digest' },
      { ...declaration, byteLength: 0 },
      { ...declaration, byteLength: 64 * 1024 * 1024 + 1 },
      { ...declaration, entries: [{ worktreeKey: WORKTREE, filePath: '' }] }
    ]) {
      expect(() => parseOrcadMigrationManifest(rawManifest(value))).toThrow(invalid)
    }
  })

  it('maps the blob one-to-one onto the declared entries', () => {
    const two: OrcadMigrationEditorDraftsDeclaration = {
      ...declaration,
      entries: [
        { worktreeKey: WORKTREE, filePath: FILE_A },
        { worktreeKey: WORKTREE, filePath: FILE_B }
      ]
    }
    const bytes = (drafts: unknown[], version = 1) =>
      Buffer.from(JSON.stringify({ version, drafts }))
    const a = { worktreeKey: WORKTREE, filePath: FILE_A, content: '' }
    const b = { worktreeKey: WORKTREE, filePath: FILE_B, content: 'b' }

    expect(parseOrcadMigrationEditorDraftsBytes(bytes([b, a]), two)).toEqual([b, a])
    expect(() => parseOrcadMigrationEditorDraftsBytes(bytes([a]), two)).toThrow(
      'orcad_migration_editor_drafts_set_mismatch'
    )
    expect(() => parseOrcadMigrationEditorDraftsBytes(bytes([a, b]), declaration)).toThrow(
      'orcad_migration_editor_drafts_set_mismatch'
    )
    expect(() => parseOrcadMigrationEditorDraftsBytes(bytes([a, a]), two)).toThrow(
      'orcad_migration_dormant_editor_drafts_entry_duplicate'
    )
    expect(() => parseOrcadMigrationEditorDraftsBytes(bytes([a], 2), declaration)).toThrow(
      'orcad_migration_editor_drafts_invalid'
    )
    expect(() =>
      parseOrcadMigrationEditorDraftsBytes(Buffer.from([0xff, 0xfe]), declaration)
    ).toThrow('orcad_migration_editor_drafts_not_json')
  })
})
