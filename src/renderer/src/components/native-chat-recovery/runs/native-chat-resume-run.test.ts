import { describe, expect, it } from 'vitest'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import {
  beginResumeRun,
  observeResumeRun,
  resumeRunInFlight,
  resumeRunPendingIds,
  type ResumeRunHostStatus
} from './native-chat-resume-run'
import { resumeRunView } from './native-chat-resume-run-view'

const row = (sessionId: string): ResumeCandidate => ({
  sessionId,
  workspaceId: 'folder',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1
})
const failure = { ...row('a'), failedAt: 2, outcome: 'unconfirmed' as const, reason: 'pending' }
const run = beginResumeRun([row('a'), row('b')], 10, 'user')

describe('the dialog over a bulk action', () => {
  it('remembers readiness and excludes skipped chats from rows and the denominator', () => {
    const observed = observeResumeRun(run, (id) => ({
      restartResume: { phase: id === 'a' ? 'skipped' : 'starting' },
      hostExecutionPhase: 'ready'
    }))
    const view = resumeRunView(observed, [row('a')], () => undefined, 'all')
    expect(view.rows).toEqual([row('b')])
    expect(view.counts).toMatchObject({ all: 1, total: 1, done: 0, inProgress: 1 })
    expect(view.statusBySession.get('b')).toEqual({
      kind: 'in-flight',
      phase: 'ready',
      startedAt: 10
    })
    const admitted = observeResumeRun(observed, () => ({ restartResume: { phase: 'starting' } }))
    expect(admitted.entries[1]).toBe(observed.entries[1])
    expect(resumeRunView(admitted, [], () => undefined, 'all').counts.total).toBe(2)
  })

  it("real action progress supersedes another request's provisional skip", () => {
    let observed = observeResumeRun(run, () => ({ restartResume: { phase: 'skipped' } }))
    for (const phase of ['queued', 'starting', 'continued'] as const) {
      observed = observeResumeRun(observed, () => ({ restartResume: { phase } }))
      expect(observed.entries[0]?.observedStatus?.restartResume?.phase).toBe(phase)
      expect(observeResumeRun(observed, () => ({ restartResume: { phase: 'skipped' } }))).toBe(
        observed
      )
    }
    expect(resumeRunView(observed, [], () => undefined, 'all').counts).toMatchObject({
      total: 2,
      resumed: 2
    })
  })
  it('settles a chat from its host verdict while the request remains in flight', () => {
    const statusFor = (id: string): ResumeRunHostStatus => ({
      restartResume: { phase: id === 'a' ? 'continued' : 'queued' }
    })
    const view = resumeRunView(run, [], () => undefined, 'all', statusFor)
    expect(view.rows.map((entry) => entry.sessionId)).toEqual(['b', 'a'])
    expect(view.statusBySession.get('a')).toEqual({ kind: 'resumed' })
    expect(view.counts).toMatchObject({ total: 2, done: 1, resumed: 1, inProgress: 1 })
    expect(resumeRunInFlight(run)).toBe(true)
    expect(resumeRunPendingIds(run)).toEqual(['a', 'b'])
  })

  it('degrades an older host to waiting until the reply, even if its ordinary status is ready', () => {
    const view = resumeRunView(
      run,
      [],
      () => undefined,
      'all',
      () => ({ hostExecutionPhase: 'ready' })
    )
    expect(view.counts.inProgress).toBe(2)
    expect(view.statusBySession.get('a')).toEqual({ kind: 'in-flight', phase: null, startedAt: 10 })
  })

  it('distinguishes waiting for a start slot from holding one and waiting for delivery', () => {
    for (const hostExecutionPhase of ['starting', 'ready'] as const) {
      const view = resumeRunView(
        run,
        [],
        () => undefined,
        'all',
        () => ({ restartResume: { phase: 'starting' }, hostExecutionPhase })
      )
      expect(view.statusBySession.get('a')).toEqual({
        kind: 'in-flight',
        phase: hostExecutionPhase,
        startedAt: 10
      })
    }
  })

  it('a retry shows its current progress over the previous failure', () => {
    const view = resumeRunView(run, [failure], () => failure, 'all')
    expect(view.counts.attention).toBe(0)
    expect(view.statusBySession.get('a')?.kind).toBe('in-flight')
  })

  it('keeps an unknown action in Need you after its host failure is withdrawn', () => {
    const finished = {
      ...run,
      inFlight: false,
      continued: [{ sessionId: 'a', outcome: 'unknown' as const }]
    }
    const failed = resumeRunView(
      finished,
      [failure],
      (id) => (id === 'a' ? failure : undefined),
      'attention'
    )
    expect(failed.rows).toEqual([failure])
    const withdrawn = resumeRunView(finished, [], () => undefined, 'attention')
    expect(withdrawn.rows).toEqual([row('a')])
    expect(withdrawn.counts.attention).toBe(1)
    expect(withdrawn.statusBySession.get('a')).toEqual({ kind: 'unconfirmed' })
    const refused = resumeRunView(
      { ...finished, continued: [{ sessionId: 'a', outcome: 'refused' }] },
      [],
      () => undefined,
      'attention'
    )
    expect(refused.rows).toEqual([])
    expect(refused.counts.attention).toBe(0)
  })

  it('shows final per-chat failures from the feed before the batch returns', () => {
    for (const phase of ['refused', 'unconfirmed'] as const) {
      const view = resumeRunView(
        run,
        [],
        () => undefined,
        'attention',
        () => ({ restartResume: { phase } })
      )
      expect(view.counts.attention).toBe(2)
      expect(view.statusBySession.get('a')).toEqual({ kind: phase })
    }
  })
})
