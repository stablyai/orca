import { describe, expect, it } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest
} from './orcad-migration/orcad-migration-manifest-validation'

const digest = 'a'.repeat(64)

function manifest(overrides: { version?: unknown; dormantState?: unknown } = {}) {
  return {
    version: overrides.version ?? ORCAD_MIGRATION_MANIFEST_VERSION,
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
      ...(overrides.dormantState === undefined ? {} : { dormantState: overrides.dormantState })
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
  it.each([2, 10, 0, '1', undefined, null])(
    'rejects manifest version %j instead of guessing its shape',
    (version) => {
      expect(() => parseOrcadMigrationManifest({ ...manifest(), version })).toThrow(
        'orcad_migration_manifest_version_unsupported'
      )
    }
  )

  it('validates folder workspace keys alongside worktree workspace keys', () => {
    const parsed = parseOrcadMigrationManifest(
      manifest({ dormantState: dormantLineage('folder:folder-1', 'worktree:repo-1::/srv/repo-1') })
    )
    expect(parsed.payload.dormantState?.workspaceLineage[0]?.lineage).toMatchObject({
      childWorkspaceKey: 'folder:folder-1',
      parentWorkspaceKey: 'worktree:repo-1::/srv/repo-1',
      childInstanceId: null,
      parentInstanceId: null
    })
  })

  it.each([
    ['a folder workspace outside the catalog', 'folder:folder-2'],
    ['a worktree outside the catalog', 'worktree:repo-2::/srv/repo-2']
  ])('refuses lineage that names %s', (_label, key) => {
    expect(() =>
      parseOrcadMigrationManifest(
        manifest({ dormantState: dormantLineage(key, 'folder:folder-1') })
      )
    ).toThrow('orcad_migration_dormant_workspace_lineage_scope_invalid')
  })

  // Retired draft-blob field from development builds; no released desktop sent it.
  it('accepts and drops the retired editorDraftsBlob declaration', () => {
    const dormantState = {
      ...dormantLineage('folder:folder-1', 'worktree:repo-1::/srv/repo-1'),
      editorDraftsBlob: { sha256: digest, byteLength: 4, entries: [] }
    }
    const parsed = parseOrcadMigrationManifest(manifest({ dormantState }))
    expect(parsed.payload.dormantState).not.toHaveProperty('editorDraftsBlob')
  })

  it('rejects a malformed workspace key rather than treating it as a worktree id', () => {
    expect(() =>
      parseOrcadMigrationManifest(
        manifest({ dormantState: dormantLineage('folder:', 'folder:folder-1') })
      )
    ).toThrow('orcad_migration_dormant_lineage_workspace_key_invalid')
  })

  it('preserves authored automation setup and canonicalizes a legacy setup projection on import', () => {
    const automation = {
      id: 'automation-1',
      name: 'Nightly checks',
      prompt: 'Run tests',
      precheck: null,
      agentId: 'codex',
      surface: 'chat',
      launchPreferences: { model: null, options: { effort: 'high', speed: 'fast' } },
      agentArgs: '--search --add-dir docs',
      runContext: {
        kind: 'workspace-run',
        projectId: 'repo:repo-1',
        hostId: 'local',
        projectHostSetupId: 'repo-1',
        repoId: 'repo-1',
        path: '/srv/repo-1'
      },
      sourceContext: null,
      projectId: 'repo-1',
      executionTargetType: 'local',
      executionTargetId: 'local',
      schedulerOwner: 'remote_host_service',
      workspaceMode: 'new_per_run',
      workspaceId: null,
      baseBranch: 'main',
      reuseSession: false,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1,
      enabled: false,
      nextRunAt: 2,
      missedRunPolicy: 'run_once_within_grace',
      missedRunGraceMinutes: 60,
      createdAt: 1,
      updatedAt: 2
    }
    const dormantState = {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      automations: [automation],
      automationRuns: []
    }
    const imported = parseOrcadMigrationManifest(manifest({ dormantState })).payload.dormantState
      ?.automations?.[0]
    expect(imported).toMatchObject({
      surface: 'chat',
      launchPreferences: { model: null, options: { effort: 'high', speed: 'fast' } },
      agentArgs: '--search --add-dir docs'
    })
    const legacyProjection = parseOrcadMigrationManifest(
      manifest({
        dormantState: {
          ...dormantState,
          automations: [
            {
              ...automation,
              launchSetup: { surface: 'chat', agentArgs: null, launchPreferences: { model: null } }
            }
          ]
        }
      })
    ).payload.dormantState?.automations?.[0]
    expect(legacyProjection).toMatchObject({
      surface: 'chat',
      agentArgs: null,
      launchPreferences: { model: null }
    })
    expect(legacyProjection).not.toHaveProperty('launchSetup')

    for (const [reuseSession, extraAgentArgs] of [
      [true, '--model opus'],
      [false, '--legacy-dormant-text']
    ] as const) {
      const nestedChat = parseOrcadMigrationManifest(
        manifest({
          dormantState: {
            ...dormantState,
            automations: [
              {
                ...automation,
                agentId: 'claude',
                surface: undefined,
                launchPreferences: undefined,
                agentArgs: undefined,
                reuseSession,
                launchSetup: { surface: 'chat', extraAgentArgs }
              }
            ]
          }
        })
      ).payload.dormantState?.automations?.[0]
      expect(nestedChat).toMatchObject({ surface: 'chat', reuseSession, extraAgentArgs })
      expect(nestedChat).not.toHaveProperty('launchSetup')
    }
    expect(() =>
      parseOrcadMigrationManifest(
        manifest({
          dormantState: {
            ...dormantState,
            automations: [
              {
                ...automation,
                agentId: 'claude',
                launchPreferences: undefined,
                agentArgs: undefined,
                launchSetup: { surface: 'terminal', extraAgentArgs: '--resume x' }
              }
            ]
          }
        })
      )
    ).toThrow('orcad_migration_dormant_automation_extra_agent_args_invalid')
  })
})
