import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { sleepingAgentSessionRecordMatchesExecutionHost } from './sleeping-agent-session-execution-owner'

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeState(
  worktrees: { id: string; repoId: string; hostId?: string }[] = [],
  folderWorkspaces: { id: string; executionHostId: 'local' | `runtime:${string}` }[] = []
) {
  return {
    allWorktrees: () => worktrees,
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    repos: [],
    folderWorkspaces,
    getKnownWorktreeById: () => null
  } as never
}

describe('sleepingAgentSessionRecordMatchesExecutionHost', () => {
  it('rejects ownerless legacy records when the worktree id exists on multiple hosts', () => {
    const state = makeState([
      { id: 'wt-1', repoId: 'repo-local', hostId: 'local' },
      { id: 'wt-1', repoId: 'repo-runtime', hostId: 'runtime:runtime-b' }
    ])

    expect(sleepingAgentSessionRecordMatchesExecutionHost(state, makeRecord(), 'local')).toBe(false)
  })

  it('uses an explicit sleeping-record owner instead of the current workspace host', () => {
    const record = makeRecord({ executionHostId: 'runtime:runtime-b' })
    const state = makeState()

    expect(sleepingAgentSessionRecordMatchesExecutionHost(state, record, 'local')).toBe(false)
    expect(sleepingAgentSessionRecordMatchesExecutionHost(state, record, 'runtime:runtime-b')).toBe(
      true
    )
  })

  it('allows metadata-free ownerless legacy records only on the local host', () => {
    const state = makeState()
    const record = makeRecord()

    expect(sleepingAgentSessionRecordMatchesExecutionHost(state, record, 'local')).toBe(true)
    expect(sleepingAgentSessionRecordMatchesExecutionHost(state, record, 'runtime:runtime-b')).toBe(
      false
    )
  })

  it('rejects an ownerless folder record when the folder id exists on multiple hosts', () => {
    const state = makeState(
      [],
      [
        { id: 'folder-1', executionHostId: 'local' },
        { id: 'folder-1', executionHostId: 'runtime:runtime-b' }
      ]
    )

    expect(
      sleepingAgentSessionRecordMatchesExecutionHost(
        state,
        makeRecord({ worktreeId: 'folder:folder-1' }),
        'local'
      )
    ).toBe(false)
  })
})
