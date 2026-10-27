/** Provider session IDs locate machine-local transcripts; resuming elsewhere fails or opens an unrelated same-ID transcript. Worktree IDs/merged sleeping records/current-catalog routing lack sufficient host scope. Refuse positively foreign records while preserving unstamped legacy resumes; absence of evidence alone cannot strand them. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import {
  agentResumeOriginNamesAnotherExecutionHost,
  sleepingRecordHostAllowsSessionClaim,
  sleepingRecordNamesAnotherExecutionHost
} from './sleeping-record-execution-host-scope'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

const initialAppStoreState = useAppStore.getState()

const TARGET_ID = 'openclaw'
const REMOTE_PATH = '/home/neil/projects/orca-test123'
const WORKTREE_ID = `repo-1::${REMOTE_PATH}`
const SESSION_ID = '87987465-66f6-4967-bf3f-0659565cbcc5'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID },
    prompt: 'finish the task',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** A catalog that resolves WORKTREE_ID to exactly `hostId`, with no tab rows for it. */
function catalogOwnedBy(hostId: ExecutionHostId): WorktreeRuntimeOwnerState {
  const connectionId = hostId.startsWith('ssh:')
    ? decodeURIComponent(hostId.slice('ssh:'.length))
    : undefined
  return {
    repos: [
      {
        id: 'repo-1',
        ...(connectionId ? { connectionId } : {}),
        ...(hostId.startsWith('runtime:') ? { executionHostId: hostId } : {})
      }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', path: REMOTE_PATH, hostId })]
    }
  }
}

describe('sleepingRecordNamesAnotherExecutionHost', () => {
  it.each([
    ['an SSH record on a different SSH target', 'other-target', `ssh:${TARGET_ID}`],
    ['an SSH record on the local host', TARGET_ID, 'local'],
    ['a local-or-runtime record on an SSH host', null, `ssh:${TARGET_ID}`]
  ] as const)('refuses %s', (_label, connectionId, hostId) => {
    const record = makeRecord({ connectionId })
    expect(sleepingRecordNamesAnotherExecutionHost(record, catalogOwnedBy(hostId))).toBe(true)
  })

  it.each([
    ['the same SSH target', TARGET_ID, `ssh:${TARGET_ID}`],
    ['a target id needing URI encoding', 'my host', 'ssh:my%20host'],
    ['a local record on the local host', null, 'local'],
    // Runtime namespaces relabel paired hosts’ local and nested-SSH workspaces; runtime alone cannot identify transcript ownership.
    ['an SSH record whose workspace now reads as a paired runtime', TARGET_ID, 'runtime:env-1'],
    ['a local-or-runtime record on a paired runtime', null, 'runtime:env-1']
  ] as const)('allows %s', (_label, connectionId, hostId) => {
    const record = makeRecord({ connectionId })
    expect(sleepingRecordNamesAnotherExecutionHost(record, catalogOwnedBy(hostId))).toBe(false)
  })

  it.each([
    ['never stamped', undefined],
    ['stamped with whitespace', '   ']
  ] as const)('fails open on a record %s', (_label, connectionId) => {
    // Legacy SSH orphans are unstamped (#9030); absence alone must not strand them.
    const record = makeRecord(connectionId === undefined ? {} : { connectionId })
    expect(
      sleepingRecordNamesAnotherExecutionHost(record, catalogOwnedBy(`ssh:${TARGET_ID}`))
    ).toBe(false)
  })

  it.each([
    ['an SSH record', TARGET_ID],
    ['a local-or-runtime record', null]
  ] as const)(
    'fails open for %s when the catalog has no row for the worktree',
    (_label, connectionId) => {
      // Missing catalog rows route local by default; that fallback cannot prove SSH records foreign before hydration.
      const record = makeRecord({ connectionId })
      expect(
        sleepingRecordNamesAnotherExecutionHost(record, {
          repos: [],
          worktreesByRepo: {},
          settings: { activeRuntimeEnvironmentId: 'unrelated' },
          runtimeEnvironments: [{ id: 'unrelated' }]
        })
      ).toBe(false)
    }
  )

  it('still refuses an SSH record once a repo row positively names the worktree local', () => {
    const record = makeRecord({ connectionId: TARGET_ID })
    expect(
      sleepingRecordNamesAnotherExecutionHost(record, {
        repos: [{ id: 'repo-1' }],
        worktreesByRepo: {},
        settings: { activeRuntimeEnvironmentId: 'unrelated' },
        runtimeEnvironments: [{ id: 'unrelated' }]
      })
    ).toBe(true)
  })
})

describe('folder-owned SSH with conflicting inherited group owners', () => {
  it.each(['local first', 'SSH first'] as const)('uses the folder target with %s', (order) => {
    const groups = [
      { id: 'group', executionHostId: 'local' },
      { id: 'group', executionHostId: 'ssh:other-target' }
    ] as const
    const state: WorktreeRuntimeOwnerState = {
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group', connectionId: TARGET_ID }],
      projectGroups: order === 'local first' ? groups : groups.toReversed()
    }
    const local = makeRecord({ worktreeId: 'folder:folder', connectionId: null })
    const matching = makeRecord({ worktreeId: 'folder:folder', connectionId: TARGET_ID })

    expect(sleepingRecordNamesAnotherExecutionHost(local, state)).toBe(true)
    expect(sleepingRecordNamesAnotherExecutionHost(matching, state)).toBe(false)
    expect(sleepingRecordHostAllowsSessionClaim(local, matching, state)).toBe(false)
    expect(sleepingRecordHostAllowsSessionClaim(matching, matching, state)).toBe(true)
  })
})

describe('agentResumeOriginNamesAnotherExecutionHost', () => {
  // Cold-restore compares against actual pane transport, not catalog routing; pin the exported host-pair form too.
  it.each([
    ['an SSH origin against another SSH pane', TARGET_ID, 'ssh:elsewhere', true],
    ['an SSH origin against a local pane', TARGET_ID, 'local', true],
    ['a local origin against an SSH pane', null, `ssh:${TARGET_ID}`, true],
    ['an SSH origin against its own pane', TARGET_ID, `ssh:${TARGET_ID}`, false],
    ['a local origin against a local pane', null, 'local', false],
    ['an SSH origin against a paired-runtime pane', TARGET_ID, 'runtime:env-1', false]
  ] as const)('reports %s as %s', (_label, originConnectionId, hostId, expected) => {
    expect(agentResumeOriginNamesAnotherExecutionHost(originConnectionId, hostId)).toBe(expected)
  })

  it.each([null, undefined])(
    'fails open when the pane has no resolved execution host (%s)',
    (hostId) => {
      // A pane whose owner is still unresolved is not evidence of a different machine.
      expect(agentResumeOriginNamesAnotherExecutionHost(TARGET_ID, hostId)).toBe(false)
    }
  )
})

/** Use connected SSH so host authority allows the sweep; otherwise unrelated connection refusal makes these assertions vacuous. */
function seedAnsweredSshWorkspace(...records: SleepingAgentSessionRecord[]): void {
  useAppStore.setState({
    repos: [{ ...TEST_REPO, id: 'repo-1', path: '/home/neil/projects', connectionId: TARGET_ID }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo-1',
          path: REMOTE_PATH,
          hostId: `ssh:${TARGET_ID}`
        })
      ]
    },
    tabsByWorktree: {},
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      records.map((record) => [record.paneKey, record])
    )
  })
  useAppStore.getState().setSshConnectionState(TARGET_ID, {
    targetId: TARGET_ID,
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  })
}

describe('the resume sweep under execution-host scope', () => {
  it('declines a locally captured session id rather than issuing it on the SSH host', () => {
    const record = makeRecord({ connectionId: null })
    seedAnsweredSshWorkspace(record)

    expect(
      resumeSleepingAgentSessionsForWorktree(WORKTREE_ID),
      'issued --resume for a local session id against the SSH host'
    ).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID] ?? []).toHaveLength(0)
  })

  it('preserves the declined record so the session stays resumable by hand', () => {
    const record = makeRecord({ connectionId: 'a-different-target' })
    seedAnsweredSshWorkspace(record)

    resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)
    resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    // Host disagreement must preserve the record, the user’s only transcript locator.
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('still resumes a session captured on the host that owns the workspace', () => {
    const record = makeRecord({ connectionId: TARGET_ID })
    seedAnsweredSshWorkspace(record)

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('still resumes a legacy record that names no host at all', () => {
    const record = makeRecord()
    seedAnsweredSshWorkspace(record)

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
  })

  it('declines only the foreign record and resumes its native sibling', () => {
    const foreign = makeRecord({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      connectionId: null,
      providerSession: { key: 'session_id', id: 'session-from-the-laptop' }
    })
    const native = makeRecord({ paneKey: 'tab-2:leaf-1', tabId: 'tab-2', connectionId: TARGET_ID })
    seedAnsweredSshWorkspace(foreign, native)

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(1)
    const state = useAppStore.getState()
    expect(state.sleepingAgentSessionsByPaneKey[foreign.paneKey]).toBe(foreign)
    expect(state.sleepingAgentSessionsByPaneKey[native.paneKey]).toBeUndefined()
  })
})

const ownerEvidenceCases: {
  name: string
  state: WorktreeRuntimeOwnerState
  connectionId: string | null
  worktreeId?: string
  foreign: boolean
}[] = [
  {
    name: 'the active local host over an SSH catalog',
    state: {
      ...catalogOwnedBy('ssh:openclaw'),
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    },
    connectionId: TARGET_ID,
    foreign: true
  },
  {
    name: 'the matching active SSH host over a local catalog',
    state: {
      ...catalogOwnedBy('local'),
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'ssh:openclaw'
    },
    connectionId: TARGET_ID,
    foreign: false
  },
  {
    name: 'a foreign detected-only SSH owner',
    state: {
      detectedWorktreesByRepo: {
        remote: { worktrees: [{ id: WORKTREE_ID, repoId: 'remote', hostId: 'ssh:other' }] }
      }
    },
    connectionId: TARGET_ID,
    foreign: true
  },
  {
    name: 'conflicting detected owners',
    state: {
      detectedWorktreesByRepo: {
        a: { worktrees: [{ id: WORKTREE_ID, repoId: 'a', hostId: 'ssh:other' }] },
        b: { worktrees: [{ id: WORKTREE_ID, repoId: 'b', hostId: 'local' }] }
      }
    },
    connectionId: TARGET_ID,
    foreign: false
  },
  ...[TARGET_ID, 'other'].map((connectionId) => ({
    name: `physical SSH ownership through a runtime for ${connectionId}`,
    state: {
      repos: [{ id: 'repo-1', connectionId: TARGET_ID, executionHostId: 'runtime:hub' as const }],
      worktreesByRepo: {
        'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', hostId: 'ssh:openclaw' as const }]
      }
    },
    connectionId,
    foreign: connectionId !== TARGET_ID
  })),
  {
    name: 'a direct SSH folder for a locally captured session',
    worktreeId: 'folder:f',
    state: { folderWorkspaces: [{ id: 'f', projectGroupId: 'g', connectionId: TARGET_ID }] },
    connectionId: null,
    foreign: true
  },
  {
    name: 'a known unstamped local folder',
    worktreeId: 'folder:f',
    state: { folderWorkspaces: [{ id: 'f', projectGroupId: 'g' }] },
    connectionId: TARGET_ID,
    foreign: true
  },
  {
    name: 'a restored runtime folder before its catalog',
    worktreeId: 'folder:f',
    state: { restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:f': 'runtime:restored' } },
    connectionId: TARGET_ID,
    foreign: false
  },
  {
    name: 'a missing folder',
    worktreeId: 'folder:f',
    state: {},
    connectionId: TARGET_ID,
    foreign: false
  },
  {
    name: 'conflicting folder owners',
    worktreeId: 'folder:f',
    state: {
      folderWorkspaces: [
        { id: 'f', projectGroupId: 'g', executionHostId: 'local' },
        { id: 'f', projectGroupId: 'g', executionHostId: 'ssh:other' }
      ]
    },
    connectionId: TARGET_ID,
    foreign: false
  },
  {
    name: 'conflicting inherited folder group owners',
    worktreeId: 'folder:f',
    state: {
      folderWorkspaces: [{ id: 'f', projectGroupId: 'g' }],
      projectGroups: [
        { id: 'g', executionHostId: 'local' },
        { id: 'g', executionHostId: 'ssh:other' }
      ]
    },
    connectionId: TARGET_ID,
    foreign: false
  }
]

it.each(ownerEvidenceCases)(
  'compares capture against $name',
  ({ state, connectionId, worktreeId, foreign }) => {
    const record = makeRecord({ connectionId, ...(worktreeId ? { worktreeId } : {}) })
    expect(
      sleepingRecordNamesAnotherExecutionHost(record, {
        settings: { activeRuntimeEnvironmentId: 'unrelated' },
        runtimeEnvironments: [{ id: 'unrelated' }],
        ...state
      })
    ).toBe(foreign)
  }
)
