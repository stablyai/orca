import { describe, expect, it } from 'vitest'
import { makeRepo } from '@/components/worktree-jump-palette-test-fixtures'
import { createTestStore, makeWorktree } from '@/store/slices/store-test-helpers'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../shared/constants'
import type { ProjectHostSetup } from '../../../shared/project-types'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { Tab } from '../../../shared/tab-types'
import {
  classifyHostStampedTerminal,
  getLocalSourceWorktreeIds,
  isPositivelyLocalSourceWorktree,
  resolveHostTerminalRoute
} from './terminal-worktree-route'

const WT = 'repo-1::/w'
const PTY = toRemoteRuntimePtyId('handle-1', 'env-b')

type TabCandidate = NonNullable<Parameters<typeof classifyHostStampedTerminal>[0]>[number]

function candidate(overrides: Partial<TabCandidate> = {}): TabCandidate {
  return {
    id: 'tab-1',
    contentType: 'terminal',
    executionHostId: 'runtime:env-b',
    projectHostSetupId: 'setup-b',
    ...overrides
  }
}

function stampedTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: WT,
    contentType: 'terminal',
    executionHostId: 'runtime:env-b',
    projectHostSetupId: 'setup-b',
    label: 'Terminal 1',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-b',
    projectId: 'project-1',
    hostId: 'runtime:env-b',
    repoId: 'repo-1',
    path: '/srv/project',
    displayName: 'project',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function runtimeEnv(id: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: 'ws'
  }
}

function focusedRuntimeSettings(environmentId: string): AppState['settings'] {
  return { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: environmentId }
}

// A positively local source whose worktree row carries no explicit hostId (legacy metadata).
function state(overrides: Partial<AppState> = {}): AppState {
  return {
    ...createTestStore().getState(),
    repos: [{ ...makeRepo(), connectionId: null, displayName: 'repo' }],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WT, repoId: 'repo-1', projectId: 'project-1' })]
    },
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    projectHostSetups: [setup()],
    unifiedTabsByWorktree: { [WT]: [stampedTab()] },
    ...overrides
  }
}

describe('classifyHostStampedTerminal', () => {
  it('treats a tab without a setup stamp as legacy, even with a foreign host', () => {
    expect(
      classifyHostStampedTerminal([candidate({ projectHostSetupId: undefined })], 'tab-1')
    ).toEqual({ kind: 'none' })
    expect(classifyHostStampedTerminal([], 'tab-1')).toEqual({ kind: 'none' })
    expect(classifyHostStampedTerminal(undefined, 'tab-1')).toEqual({ kind: 'none' })
  })

  it('recognizes a valid stamp', () => {
    expect(classifyHostStampedTerminal([candidate()], 'tab-1')).toEqual({
      kind: 'stamped',
      environmentId: 'env-b',
      executionHostId: 'runtime:env-b',
      projectHostSetupId: 'setup-b'
    })
  })

  const MALFORMED_STAMPS: [string, Partial<TabCandidate>, string][] = [
    ['blank setup', { projectHostSetupId: '  ' }, 'missing_setup'],
    ['non-string setup', { projectHostSetupId: 42 }, 'missing_setup'],
    ['null setup', { projectHostSetupId: null }, 'missing_setup'],
    ['missing host', { executionHostId: undefined }, 'host_not_runtime'],
    ['local host', { executionHostId: 'local' }, 'host_not_runtime'],
    ['ssh host', { executionHostId: 'ssh:box' }, 'host_not_runtime'],
    ['malformed host', { executionHostId: 'runtime:' }, 'host_not_runtime'],
    ['unknown host', { executionHostId: 'mystery:x' }, 'host_not_runtime'],
    ['non-string host', { executionHostId: 7 }, 'host_not_runtime'],
    ['editor tab', { contentType: 'editor' }, 'not_terminal']
  ]

  it.each(MALFORMED_STAMPS)(
    'refuses (never legacy) a stamp with %s',
    (_label, overrides, reason) => {
      expect(classifyHostStampedTerminal([candidate(overrides)], 'tab-1')).toEqual({
        kind: 'invalid',
        reason
      })
    }
  )

  it('refuses duplicate ids when any copy carries the stamp', () => {
    const tabs = [candidate({ projectHostSetupId: undefined }), candidate()]
    expect(classifyHostStampedTerminal(tabs, 'tab-1')).toEqual({
      kind: 'invalid',
      reason: 'ambiguous_tab'
    })
  })
})

describe('isPositivelyLocalSourceWorktree', () => {
  it('proves a local source from the catalog without an explicit hostId', () => {
    expect(isPositivelyLocalSourceWorktree(state(), WT)).toBe(true)
  })

  it('keeps a local source local when a runtime is focused', () => {
    expect(
      isPositivelyLocalSourceWorktree(
        state({
          settings: focusedRuntimeSettings('hub'),
          runtimeEnvironments: [runtimeEnv('hub')]
        }),
        WT
      )
    ).toBe(true)
  })

  const REFUSED_SOURCES: [string, Partial<AppState>][] = [
    ['a missing row', { worktreesByRepo: {} }],
    [
      'duplicate rows',
      {
        worktreesByRepo: {
          'repo-1': [
            makeWorktree({ id: WT, repoId: 'repo-1' }),
            makeWorktree({ id: WT, repoId: 'repo-1' })
          ]
        }
      }
    ],
    [
      'runtime-owner provenance',
      {
        worktreesByRepo: {
          'repo-1': [
            makeWorktree({
              id: WT,
              repoId: 'repo-1',
              hostId: 'local',
              runtimeOwnerEnvironmentId: 'hub'
            })
          ]
        }
      }
    ],
    [
      'a runtime hostId',
      {
        worktreesByRepo: {
          'repo-1': [makeWorktree({ id: WT, repoId: 'repo-1', hostId: 'runtime:hub' })]
        }
      }
    ],
    [
      'repo runtime provenance',
      { repos: [{ ...makeRepo(), connectionId: null, executionHostId: 'runtime:hub' }] }
    ],
    ['an SSH repo', { repos: [{ ...makeRepo(), connectionId: 'box', executionHostId: null }] }]
  ]

  it.each(REFUSED_SOURCES)('refuses %s', (_label, overrides) => {
    expect(isPositivelyLocalSourceWorktree(state(overrides), WT)).toBe(false)
  })
})

describe('resolveHostTerminalRoute', () => {
  it('returns null for a tab with no setup stamp', () => {
    const unstamped = state({
      unifiedTabsByWorktree: { [WT]: [stampedTab({ projectHostSetupId: undefined })] }
    })
    expect(resolveHostTerminalRoute(unstamped, WT, 'tab-1', [PTY])).toBeNull()
  })

  it('routes to the ready setup folder on the stamped host', () => {
    expect(resolveHostTerminalRoute(state(), WT, 'tab-1', [PTY, null])).toEqual({
      kind: 'host-terminal',
      environmentId: 'env-b',
      executionHostId: 'runtime:env-b',
      projectHostSetupId: 'setup-b',
      targetWorktreeSelector: 'path:/srv/project'
    })
  })

  it('takes the host from the stamp, never from the focused runtime', () => {
    const focused = state({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: WT, repoId: 'repo-1', projectId: 'project-1', hostId: 'local' })
        ]
      },
      settings: focusedRuntimeSettings('env-x'),
      runtimeEnvironments: [runtimeEnv('env-x'), runtimeEnv('env-b')]
    })
    expect(resolveHostTerminalRoute(focused, WT, 'tab-1', [PTY])).toMatchObject({
      kind: 'host-terminal',
      environmentId: 'env-b'
    })
  })

  it('refuses an invalid stamp instead of returning legacy', () => {
    const invalid = state({
      unifiedTabsByWorktree: { [WT]: [stampedTab({ executionHostId: 'ssh:box' })] }
    })
    expect(resolveHostTerminalRoute(invalid, WT, 'tab-1', [PTY])).toEqual({
      kind: 'refused',
      reason: 'host_not_runtime'
    })
  })

  it('refuses a source that is not positively local', () => {
    const remoteSource = state({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: WT,
            repoId: 'repo-1',
            projectId: 'project-1',
            runtimeOwnerEnvironmentId: 'hub'
          })
        ]
      }
    })
    expect(resolveHostTerminalRoute(remoteSource, WT, 'tab-1', [PTY])).toEqual({
      kind: 'refused',
      reason: 'source_worktree_not_local'
    })
  })

  it.each([
    ['not ready', [setup({ setupState: 'not-set-up' })]],
    ['another project', [setup({ projectId: 'project-2' })]],
    ['another host', [setup({ hostId: 'runtime:env-c' })]],
    ['an SSH connection', [setup({ connectionId: 'box' })]],
    ['a blank path', [setup({ path: '  ' })]],
    ['missing', []],
    ['duplicated', [setup(), setup({ path: '/srv/other' })]]
  ])('refuses a setup that is %s', (_label, projectHostSetups) => {
    expect(resolveHostTerminalRoute(state({ projectHostSetups }), WT, 'tab-1', [PTY])).toEqual({
      kind: 'refused',
      reason: 'setup_not_ready'
    })
  })

  it.each([
    ['a local PTY', 'pty-local-1'],
    ['an ownerless remote PTY', 'remote:handle-1'],
    ['a foreign remote PTY', toRemoteRuntimePtyId('handle-1', 'env-c')],
    ['a blank remote handle', toRemoteRuntimePtyId('', 'env-b')]
  ])('refuses %s on a host-stamped tab', (_label, ptyId) => {
    expect(resolveHostTerminalRoute(state(), WT, 'tab-1', [PTY, ptyId])).toEqual({
      kind: 'refused',
      reason: 'pty_owner_mismatch'
    })
  })
})

describe('getLocalSourceWorktreeIds', () => {
  it('proves only worktrees that hold a setup-stamped tab', () => {
    const withUnstamped = state({
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: WT, repoId: 'repo-1' }),
          makeWorktree({ id: 'repo-1::/other', repoId: 'repo-1' })
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [stampedTab()],
        'repo-1::/other': [stampedTab({ id: 'tab-2', projectHostSetupId: undefined })]
      }
    })
    expect([...getLocalSourceWorktreeIds(withUnstamped)]).toEqual([WT])
  })

  it('drops the proof when the source gains runtime provenance', () => {
    const flipped = state({
      repos: [{ ...makeRepo(), connectionId: null, executionHostId: 'runtime:hub' }]
    })
    expect(getLocalSourceWorktreeIds(state()).has(WT)).toBe(true)
    expect(getLocalSourceWorktreeIds(flipped).has(WT)).toBe(false)
  })
})
