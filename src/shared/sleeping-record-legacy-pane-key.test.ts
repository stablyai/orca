import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { findLegacyNumericSleepingRecord } from './sleeping-record-legacy-pane-key'
import { worktreeIdsEqual } from './worktree/id'

// An SSH workspace: its records name the remote path, as the desktop window reads them.
const SSH_WORKSPACE = 'ssh-repo::/home/dev/project'

function record(paneKey: string, id: string, capturedAt = 1): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: SSH_WORKSPACE,
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    prompt: 'finish',
    state: 'done',
    capturedAt,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
}

const inWorkspace = (candidate: SleepingAgentSessionRecord): boolean =>
  worktreeIdsEqual(candidate.worktreeId, SSH_WORKSPACE)

describe('findLegacyNumericSleepingRecord', () => {
  it('takes the record with the pane’s number', () => {
    const records = { 'tab-1:2': record('tab-1:2', 'a'), 'tab-1:3': record('tab-1:3', 'b') }
    expect(
      findLegacyNumericSleepingRecord(records, { tabId: 'tab-1', numericPaneId: '3' }, inWorkspace)
    ).toMatchObject({ paneKey: 'tab-1:3', aliases: ['tab-1:2', 'tab-1:3'] })
  })

  it('with no number (main), takes the oldest alias of the tab’s one conversation', () => {
    const records = {
      'tab-1:2': record('tab-1:2', 'a', 5),
      'tab-1:3': record('tab-1:3', 'a', 2)
    }
    expect(findLegacyNumericSleepingRecord(records, { tabId: 'tab-1' }, inWorkspace)).toMatchObject(
      { paneKey: 'tab-1:3' }
    )
  })

  it('takes nothing when the tab’s numbered records name two conversations, or another workspace', () => {
    const two = { 'tab-1:2': record('tab-1:2', 'a'), 'tab-1:3': record('tab-1:3', 'b') }
    expect(findLegacyNumericSleepingRecord(two, { tabId: 'tab-1' }, inWorkspace)).toBeNull()
    const elsewhere = { 'tab-1:2': { ...record('tab-1:2', 'a'), worktreeId: 'repo::/other' } }
    expect(findLegacyNumericSleepingRecord(elsewhere, { tabId: 'tab-1' }, inWorkspace)).toBeNull()
  })
})
