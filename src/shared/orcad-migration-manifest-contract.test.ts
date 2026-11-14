import { describe, expect, it } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from './orcad-migration/orcad-migration-manifest-validation'

const digest = 'a'.repeat(64)

function manifest(dormantState: unknown) {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-contract',
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
      projectGroups: [
        {
          id: 'group-1',
          name: 'Folders',
          tabOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          parentPath: null,
          parentGroupId: null,
          isCollapsed: false,
          color: null,
          createdFrom: 'manual'
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'Notes',
          folderPath: '/srv/notes',
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1,
          isArchived: false,
          isUnread: false,
          isPinned: false
        }
      ],
      dormantState
    },
    manifestSha256: digest
  }
}

function dormantLineage(childWorkspaceKey: string, parentWorkspaceKey: string) {
  const lineage = {
    childWorkspaceKey,
    parentWorkspaceKey,
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  return {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: [],
    workspaceLineage: [{ sourceKey: childWorkspaceKey, childWorkspaceKey, lineage }],
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
}

describe('orcad migration manifest contract', () => {
  it.each([
    ['a folder workspace outside the catalog', 'folder:folder-2'],
    ['a worktree outside the catalog', 'worktree:repo-2::/srv/repo-2']
  ])('refuses lineage that names %s', (_label, key) => {
    expect(() =>
      parseOrcadMigrationManifest(manifest(dormantLineage(key, 'folder:folder-1')))
    ).toThrow('orcad_migration_dormant_workspace_lineage_scope_invalid')
  })
})
