import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import { buildOwnedEditorFileId } from '../file-ids/editor-file-ids'
import { buildHydratedEditorSessionState } from './hydrated-editor-session-state'

const SIBLING = 'repo-a::/repo-a-2'
const FILE_PATH = '/repo-a/src/a.ts'
const OWNED = buildOwnedEditorFileId(FILE_PATH, SIBLING, null)

/** A tab Orca moved to the workspace owning its file, saved under the file's owned id. */
const session: WorkspaceSessionState = {
  activeRepoId: null,
  activeWorktreeId: null,
  activeTabId: null,
  tabsByWorktree: {},
  terminalLayoutsByTabId: {},
  openFilesByWorktree: {
    [SIBLING]: [
      { filePath: FILE_PATH, relativePath: 'src/a.ts', worktreeId: SIBLING, language: 'typescript' }
    ]
  },
  unifiedTabs: {
    [SIBLING]: [
      {
        id: 'tab-1',
        entityId: OWNED,
        groupId: 'group-1',
        worktreeId: SIBLING,
        contentType: 'editor',
        label: 'a.ts',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
}

describe('buildHydratedEditorSessionState', () => {
  it('restores a moved tab’s file under the owned id the tab names, from a restart or a frame', () => {
    const restored = buildHydratedEditorSessionState(session, new Set([SIBLING]), null)

    expect(restored.state.openFiles.map((file) => file.id)).toEqual([OWNED])
    expect(restored.editorFileIdMigrationsByWorktree[SIBLING]?.get(OWNED)).toBeUndefined()
  })

  it('keeps the moved tab’s owned id apart from a sibling showing the same path, in any frame', () => {
    const OTHER = 'repo-a::/repo-a'
    const both: WorkspaceSessionState = {
      ...session,
      openFilesByWorktree: {
        ...session.openFilesByWorktree,
        [OTHER]: [
          {
            filePath: FILE_PATH,
            relativePath: 'src/a.ts',
            worktreeId: OTHER,
            language: 'typescript'
          }
        ]
      },
      unifiedTabs: {
        ...session.unifiedTabs,
        [OTHER]: [
          {
            ...session.unifiedTabs![SIBLING]![0]!,
            id: 'tab-2',
            entityId: FILE_PATH,
            worktreeId: OTHER
          }
        ]
      }
    }
    const idsOf = (workspaces: string[]) =>
      buildHydratedEditorSessionState(both, new Set(workspaces), null).state.openFiles.map(
        (file) => [file.worktreeId, file.id]
      )

    expect(idsOf([SIBLING, OTHER])).toEqual([
      [SIBLING, OWNED],
      [OTHER, FILE_PATH]
    ])
    expect(idsOf([SIBLING])).toEqual([[SIBLING, OWNED]])
    expect(idsOf([OTHER])).toEqual([[OTHER, FILE_PATH]])
  })
})
