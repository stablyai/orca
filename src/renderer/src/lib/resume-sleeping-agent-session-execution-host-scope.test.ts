/** Provider session IDs locate machine-local transcripts; resuming elsewhere fails or opens an unrelated same-ID transcript. Worktree IDs/merged sleeping records/current-catalog routing lack sufficient host scope. Refuse positively foreign records while preserving unstamped legacy resumes; absence of evidence alone cannot strand them. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'

import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import './sleeping-record-execution-host-scope'

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
