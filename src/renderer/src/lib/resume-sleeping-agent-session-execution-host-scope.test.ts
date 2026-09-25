/**
 * A provider session id names a transcript in ONE machine's agent state directory. Replaying a
 * record captured on host A as a `--resume` executed on host B answers
 * `No conversation found with session ID: <id>` at best, and at worst reopens an unrelated
 * transcript that happens to share the id.
 *
 * Nothing in the resume path was host-scoped: `worktreeId` is `repoId::path` with no host component
 * (shared/worktree/host-qualified-identity.ts), sleeping records are `'sleepingAgentKeyed'` so the
 * boot-time host-contention parking never arbitrates them and every partition's records merge into
 * one map, and `launchSleepingAgentSession` resolves its launch target from the *current* catalog.
 *
 * Both directions matter. The sweep must decline when the record names another machine, and it must
 * still resume everything it cannot positively rule out — a gate that refuses on absent evidence
 * would strand every record captured before the stamp existed.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import {
  agentResumeOriginNamesAnotherExecutionHost,
  sleepingRecordNamesAnotherExecutionHost
} from './sleeping-record-execution-host-scope'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

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
    // A paired client renames its host's workspaces — including that host's SSH ones — into its own
    // runtime namespace, so a runtime answer is no evidence about the machine holding the transcript.
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
    // #9030 leaves SSH orphans unstamped. Refusing on absent evidence would strand every record
    // captured before the stamp existed, which is a worse failure than the one being fixed.
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
      // The routing resolver answers `'local'` for a worktree it has no row for. Read as a host, that
      // would make every SSH record look foreign until its repo row lands — a gate that never resumes
      // yours is the inverse of the defect and worse.
      const record = makeRecord({ connectionId })
      expect(
        sleepingRecordNamesAnotherExecutionHost(record, { repos: [], worktreesByRepo: {} })
      ).toBe(false)
    }
  )

  it('still refuses an SSH record once a repo row positively names the worktree local', () => {
    const record = makeRecord({ connectionId: TARGET_ID })
    expect(
      sleepingRecordNamesAnotherExecutionHost(record, {
        repos: [{ id: 'repo-1' }],
        worktreesByRepo: {}
      })
    ).toBe(true)
  })
})

describe('agentResumeOriginNamesAnotherExecutionHost', () => {
  // The pane cold-restore path asks the same question against the transport the pane is attached to
  // rather than the catalog, so the host-pair form is exported and pinned separately.
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

/** The SSH workspace after its host has answered, so terminal-host authority is decided and the
 *  sweep is allowed to act. Without the hydration mark the sweep declines for an unrelated reason
 *  and every assertion below would pass vacuously. */
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
  useAppStore.getState().markRemoteWorkspaceHydrated(TARGET_ID)
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

    // Declining is recoverable only if the record survives; deleting it on a host disagreement
    // would destroy the user's only handle on that transcript.
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
