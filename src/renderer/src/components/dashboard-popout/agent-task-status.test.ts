import { describe, expect, it } from 'vitest'
import { dashboardRowBucketProjection } from '../dashboard/dashboard-row-bucket'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  currentTaskNote,
  isOlderResponse,
  readTaskNote,
  RECENT_RESPONSE_MS,
  taskBucket,
  taskNoteIdentity,
  taskObservation,
  taskResultVerified,
  type DashboardTaskNote
} from './agent-task-status'

const done: DashboardCard = {
  paneKey: 'pane',
  ptyId: null,
  agentType: 'codex',
  bucket: 'done',
  dotState: 'done',
  task: 'Review source map',
  repoId: 'repo',
  worktreeId: 'folder',
  tabId: 'tab',
  leafId: null,
  repoName: 'Project',
  worktreeName: 'Sources',
  workspaceKind: 'folder',
  startedAt: 1,
  finishedAt: 100,
  stateChangedAt: 100,
  unseen: true
}

function note(
  card: DashboardCard,
  status: DashboardTaskNote['status'] = 'verified'
): DashboardTaskNote {
  return {
    title: 'Source map',
    status,
    summary: 'Reviewed',
    nextStep: 'Read the report',
    owner: 'Reviewer',
    reviewReference: 'reviews/source-map.md',
    observation: taskObservation(card),
    savedAt: 101
  }
}

describe('dashboard task outcomes', () => {
  it('does not infer verification from completion, naming or a merged PR', () => {
    expect(
      taskResultVerified({
        ...done,
        conversationName: 'Done/AINF/Review',
        review: { number: 3, state: 'merged' }
      })
    ).toBe(false)
    expect(taskResultVerified(done, note(done))).toBe(true)
    expect(taskResultVerified(done, { ...note(done), reviewReference: ' ' })).toBe(false)
  })

  it('invalidates all old details when the agent starts or completes a new turn', () => {
    const reviewed = note(done)
    const working: DashboardCard = {
      ...done,
      bucket: 'working',
      dotState: 'working',
      stateChangedAt: 200
    }
    expect(currentTaskNote(working, reviewed)).toBeUndefined()
    expect(taskResultVerified(working, reviewed)).toBe(false)
    expect(taskResultVerified({ ...done, finishedAt: 300 }, reviewed)).toBe(false)
  })

  it('preserves verification and waiting through the production read-acknowledgement projection', () => {
    const entry = {
      state: 'done' as const,
      paneKey: done.paneKey,
      prompt: '',
      updatedAt: 100,
      stateStartedAt: 100,
      stateHistory: []
    }
    const row = { paneKey: done.paneKey, entry, state: 'done' as const, startedAt: 1 }
    const records = {
      liveTurns: { [done.paneKey]: entry },
      retainedTurns: {},
      acknowledgedTurnStartedAt: {}
    }
    const unread = { ...done, ...dashboardRowBucketProjection(row, records) }
    const read = {
      ...done,
      ...dashboardRowBucketProjection(row, {
        ...records,
        acknowledgedTurnStartedAt: { [done.paneKey]: 100 }
      }),
      lastAgentMessage: 'Loaded preview'
    }
    expect(unread.bucket).toBe('done')
    expect(read.bucket).toBe('idle')
    expect(taskResultVerified(read, note(unread))).toBe(true)
    expect(taskBucket(read, note(unread))).toBe('done')
    expect(taskBucket(read, note(unread, 'waiting-input'))).toBe('waiting-input')
    expect(taskBucket(read, note(unread, 'waiting-user'))).toBe('attention')
    expect(taskBucket(read)).toBe('done')
    expect(currentTaskNote(read, note(unread))?.title).toBe('Source map')
  })

  it('does not let a stale waiting note hide a live permission request or running agent', () => {
    const waiting = note(done, 'waiting-input')
    expect(taskBucket(done, waiting)).toBe('waiting-input')
    expect(taskBucket({ ...done, bucket: 'attention', dotState: 'waiting' }, waiting)).toBe(
      'attention'
    )
    expect(taskBucket({ ...done, bucket: 'working', dotState: 'working' }, waiting)).toBe('working')
  })

  it('keeps explicit waiting tabs visible without pretending to know who must answer', () => {
    expect(taskBucket({ ...done, conversationName: 'Wait/AINF/Source' })).toBe('waiting-input')
    expect(taskBucket({ ...done, bucket: 'idle', conversationName: 'Wait/AINF/Source' })).toBe(
      'waiting-input'
    )
    expect(taskBucket({ ...done, conversationName: 'Please Wait/for/the/result' })).toBe('done')
    const named = { ...done, conversationName: 'Wait/AINF/Source' }
    expect(taskBucket(named, note(named, 'automatic'))).toBe('done')
  })

  it('folds only timed responses older than 24 hours, keeping waiting and unknown times visible', () => {
    const now = done.finishedAt! + RECENT_RESPONSE_MS
    expect(isOlderResponse(done, undefined, now - 1)).toBe(false)
    expect(isOlderResponse(done, undefined, now)).toBe(true)
    expect(isOlderResponse(done, note(done, 'waiting-user'), now)).toBe(false)
    expect(isOlderResponse(done, note(done, 'waiting-input'), now)).toBe(false)
    expect(isOlderResponse({ ...done, finishedAt: null }, undefined, now)).toBe(false)
  })

  it('isolates identical pane ids on different hosts and folder workspaces', () => {
    const remote = { ...done, hostKind: 'ssh' as const, executionHostId: 'ssh:one' as const }
    expect(taskNoteIdentity(done)).not.toBe(taskNoteIdentity(remote))
    expect(taskNoteIdentity(remote)).not.toBe(
      taskNoteIdentity({ ...remote, executionHostId: 'ssh:two' })
    )
    expect(taskNoteIdentity(done)).not.toBe(
      taskNoteIdentity({ ...done, worktreeId: 'other-folder' })
    )
  })

  it('ignores malformed and oversized stored records instead of breaking the live board', () => {
    expect(readTaskNote('{broken')).toBeUndefined()
    expect(readTaskNote(JSON.stringify({ ...note(done), owner: 'x'.repeat(121) }))).toBeUndefined()
    expect(readTaskNote(JSON.stringify({ ...note(done), status: 'invented' }))).toBeUndefined()
    expect(readTaskNote(JSON.stringify(note(done)))).toEqual(note(done))
  })
})
