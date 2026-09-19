import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import {
  MAX_ORCAD_MIGRATION_DORMANT_NAMESPACES,
  MAX_ORCAD_MIGRATION_DORMANT_ROWS,
  MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS,
  MAX_ORCAD_MIGRATION_MANIFEST_BYTES,
  normalizeOrcadMigrationImportReceipts,
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest,
  serializeOrcadMigrationValue,
  type OrcadMigrationImportReceipt
} from './orcad-migration-manifest'

function receipt(index: number, overrides: Partial<OrcadMigrationImportReceipt> = {}) {
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: `migration-${index}`,
    manifestSha256: index.toString(16).padStart(64, '0'),
    source: {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 1,
      targetLabel: 'Production'
    },
    importedAt: new Date(index * 1_000).toISOString(),
    repositoryIds: [],
    projectGroupIds: [],
    folderWorkspaceIds: [],
    ...overrides
  }
}

describe('orcad migration manifest', () => {
  it('serializes object keys deterministically without locale ordering', () => {
    expect(
      serializeOrcadMigrationValue({ z: 1, Z: 2, nested: { ä: 3, a: 4 }, omitted: undefined })
    ).toBe('{"Z":2,"nested":{"a":4,"ä":3},"z":1}')
  })

  it('keeps the newest bounded set of valid unique receipts', () => {
    const candidates = Array.from({ length: MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS + 2 }, (_, index) =>
      receipt(index)
    )
    candidates.push(receipt(10, { source: { ...receipt(10).source, targetLabel: 'Newest' } }))
    candidates.push({ invalid: true } as never)

    const normalized = normalizeOrcadMigrationImportReceipts(candidates)

    expect(normalized).toHaveLength(MAX_ORCAD_MIGRATION_IMPORT_RECEIPTS)
    expect(normalized.some((entry) => entry.migrationId === 'migration-0')).toBe(false)
    expect(
      normalized.find((entry) => entry.migrationId === 'migration-10')?.source.targetLabel
    ).toBe('Newest')
  })

  it('normalizes receipts without Node 20-only array methods', () => {
    const prototype = Array.prototype as unknown as { toReversed?: unknown }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toReversed')
    try {
      Object.defineProperty(prototype, 'toReversed', {
        configurable: true,
        value: undefined,
        writable: true
      })
      expect(normalizeOrcadMigrationImportReceipts([receipt(1), receipt(2)])).toHaveLength(2)
    } finally {
      if (descriptor) {
        Object.defineProperty(prototype, 'toReversed', descriptor)
      } else {
        delete prototype.toReversed
      }
    }
  })

  it('drops a receipt with duplicate catalog identities', () => {
    expect(
      normalizeOrcadMigrationImportReceipts([receipt(1, { repositoryIds: ['repo-1', 'repo-1'] })])
    ).toEqual([])
  })

  it('accepts bounded dormant state and rejects rows outside the catalog scope', () => {
    const candidate = {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-dormant',
      createdAt: '2026-08-30T12:00:00.000Z',
      source: receipt(1).source,
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
          worktreeMeta: [
            {
              sourceKey: 'repo-1::/srv/worktree',
              worktreeId: 'repo-1::/srv/worktree',
              meta: {
                displayName: '',
                comment: '',
                linkedIssue: null,
                linkedPR: null,
                linkedLinearIssue: null,
                isArchived: false,
                isUnread: false,
                isPinned: false,
                sortOrder: 1,
                lastActivityAt: 1,
                hostId: 'local'
              }
            }
          ],
          worktreeLineage: [],
          workspaceLineage: [],
          sparsePresets: [],
          retiredWorktreeNames: [],
          retiredWorktreeNamespaces: [],
          workspaceSession: {
            ...getDefaultWorkspaceSession(),
            tabsByWorktree: {
              'repo-1::/srv/worktree': [
                {
                  id: 'tab-dormant',
                  ptyId: null,
                  worktreeId: 'repo-1::/srv/worktree',
                  title: 'Dormant terminal',
                  customTitle: null,
                  color: null,
                  sortOrder: 0,
                  createdAt: 1
                }
              ]
            }
          }
        }
      },
      manifestSha256: 'a'.repeat(64)
    }

    expect(parseOrcadMigrationManifest(candidate).payload.dormantState?.worktreeMeta).toHaveLength(
      1
    )
    expect(
      parseOrcadMigrationManifest(candidate).payload.dormantState?.workspaceSession?.tabsByWorktree
    ).toHaveProperty('repo-1::/srv/worktree')
    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: [
              {
                ...candidate.payload.dormantState.worktreeMeta[0],
                worktreeId: 'repo-other::/srv/worktree'
              }
            ]
          }
        }
      })
    ).toThrow('orcad_migration_dormant_worktree_meta_scope_invalid')

    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            workspaceSession: {
              ...candidate.payload.dormantState.workspaceSession,
              tabsByWorktree: {
                'repo-1::/srv/worktree': [
                  {
                    ...candidate.payload.dormantState.workspaceSession.tabsByWorktree[
                      'repo-1::/srv/worktree'
                    ][0],
                    ptyId: 'pty-live'
                  }
                ]
              }
            }
          }
        }
      })
    ).toThrow('orcad_migration_dormant_workspace_session_pty_invalid')

    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: Array.from(
              { length: MAX_ORCAD_MIGRATION_DORMANT_ROWS + 1 },
              () => candidate.payload.dormantState.worktreeMeta[0]
            )
          }
        }
      })
    ).toThrow('orcad_migration_dormant_worktree_meta_too_many')

    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            retiredWorktreeNamespaces: Array.from(
              { length: MAX_ORCAD_MIGRATION_DORMANT_NAMESPACES + 1 },
              () => ({
                sourceNamespaceKeys: ['ssh:source:/srv/orca-worktrees'],
                namespaceKey: 'local:/srv/orca-worktrees',
                registry: { exhaustedTiers: 0, names: ['nautilus'] }
              })
            )
          }
        }
      })
    ).toThrow('orcad_migration_dormant_retirement_namespaces_too_many')

    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            worktreeMeta: [
              {
                ...candidate.payload.dormantState.worktreeMeta[0],
                meta: {
                  ...candidate.payload.dormantState.worktreeMeta[0].meta,
                  comment: 'x'.repeat(MAX_ORCAD_MIGRATION_MANIFEST_BYTES)
                }
              }
            ]
          }
        }
      })
    ).toThrow('orcad_migration_manifest_too_large')
  })

  it('accepts only destination-owned disabled automations with final run history', () => {
    const automation = {
      id: 'automation-1',
      name: 'Nightly checks',
      prompt: 'Run tests',
      precheck: null,
      agentId: 'codex',
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
    const run = {
      id: 'run-1',
      automationId: automation.id,
      runContext: automation.runContext,
      sourceContext: null,
      title: 'Nightly checks run 1',
      scheduledFor: 1,
      status: 'completed',
      trigger: 'scheduled',
      workspaceId: null,
      sessionKind: 'terminal',
      chatSessionId: null,
      terminalSessionId: 'tab-history',
      terminalPaneKey: null,
      terminalPtyId: 'pty-history',
      outputSnapshot: {
        format: 'plain_text',
        content: 'all green',
        capturedAt: 2,
        truncated: false
      },
      precheckResult: null,
      usage: null,
      error: null,
      startedAt: 1,
      dispatchedAt: 1,
      createdAt: 1
    }
    const candidate = {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: 'migration-automation',
      createdAt: '2026-08-30T12:00:00.000Z',
      source: receipt(1).source,
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
          automations: [automation],
          automationRuns: [run]
        }
      },
      manifestSha256: 'a'.repeat(64)
    }

    expect(
      parseOrcadMigrationManifest(candidate).payload.dormantState?.automationRuns?.[0]
        ?.outputSnapshot?.content
    ).toBe('all green')
    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            automations: [{ ...automation, enabled: true }]
          }
        }
      })
    ).toThrow('orcad_migration_dormant_automation_owner_invalid')
    expect(() =>
      parseOrcadMigrationManifest({
        ...candidate,
        payload: {
          ...candidate.payload,
          dormantState: {
            ...candidate.payload.dormantState,
            automationRuns: [{ ...run, status: 'dispatching' }]
          }
        }
      })
    ).toThrow('orcad_migration_dormant_automation_run_status_invalid')
  })
})
