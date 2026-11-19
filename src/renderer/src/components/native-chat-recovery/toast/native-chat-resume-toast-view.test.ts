import { describe, expect, it } from 'vitest'
import type { ResumeCandidate, ResumeFailure } from '../tree/native-chat-resume-on-restart-grouping'
import { withoutResumeRunSessions, type ResumeRun } from '../runs/native-chat-resume-run'
import { resumeRunFailures } from '../runs/native-chat-resume-run-view'
import { resumeToastView } from './native-chat-resume-toast-view'

function chat(sessionId: string): ResumeCandidate {
  return {
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'codex',
    trigger: 'update',
    latestPrompt: 'fix the build',
    recordedAt: 1
  }
}

describe('resume toast view', () => {
  it('credits only host-confirmed chats as resumed; an unconfirmed reply needs the person', () => {
    const run: ResumeRun = {
      startedAt: 1,
      startedBy: 'launch',
      entries: [{ candidate: chat('ok') }, { candidate: chat('lost') }],
      inFlight: false,
      continued: [
        { sessionId: 'ok', outcome: 'continued' },
        { sessionId: 'lost', outcome: 'unknown' }
      ]
    }

    const view = resumeToastView(run, [], resumeRunFailures(run, []))

    expect(view.phase).toBe('finished')
    expect(view.counts).toEqual({ resumed: 1, resuming: 0, needsYou: 1, total: 2 })
    expect(view.rows.map((row) => [row.candidate.sessionId, row.state])).toEqual([
      ['lost', 'needs-you'],
      ['ok', 'resumed']
    ])
  })

  it('leaves a failure the host will not retry out of Resume', () => {
    const unretryable: ResumeFailure = {
      ...chat('stuck'),
      failedAt: 1,
      outcome: 'refused',
      reason: 'agent_session_not_attached',
      retryable: false
    }

    const view = resumeToastView(null, [chat('stopped')], new Map([['stuck', unretryable]]))

    expect(view.phase).toBe('offer')
    expect(view.resumable).toEqual(['stopped'])
    expect(view.counts.needsYou).toBe(1)
  })

  it('keeps a chat the host refused without a failure record, as Open-only', () => {
    const run: ResumeRun = {
      startedAt: 1,
      startedBy: 'user',
      entries: [{ candidate: chat('refused') }],
      inFlight: false,
      continued: [{ sessionId: 'refused', outcome: 'refused' }]
    }

    const view = resumeToastView(run, [], resumeRunFailures(run, []))

    expect(view.rows).toEqual([{ candidate: chat('refused'), state: 'needs-you', openOnly: true }])
    expect(view.counts.needsYou).toBe(1)
    expect(view.resumable).toEqual([])
  })

  it('does not bring back a refused chat once it was dismissed', () => {
    const settled: ResumeRun = {
      startedAt: 1,
      startedBy: 'user',
      entries: [{ candidate: chat('ok') }, { candidate: chat('refused') }],
      inFlight: false,
      continued: [
        { sessionId: 'ok', outcome: 'continued' },
        { sessionId: 'refused', outcome: 'refused' }
      ]
    }
    const run = withoutResumeRunSessions(settled, ['refused'])

    const view = resumeToastView(run, [], resumeRunFailures(run, []))

    expect(view.rows.map((row) => [row.candidate.sessionId, row.state])).toEqual([
      ['ok', 'resumed']
    ])
    expect(view.counts.needsYou).toBe(0)
  })
})
