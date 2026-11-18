import { describe, expect, it } from 'vitest'
import {
  buildAntigravitySwarmSnapshot,
  parseAntigravityMemberTranscript,
  summarizeAntigravityTranscript
} from './antigravity-swarm-wire'

describe('antigravity-swarm-wire', () => {
  it('builds a snapshot with member state, unread counts, @mentions, and channels', () => {
    const membersJson = JSON.stringify({
      title: 'Auth refactor swarm',
      members: {
        coordinator: {
          conversation_id: '11111111-1111-4111-8111-111111111111',
          model: 'gemini-3.1-pro-high',
          role: 'coordinator',
          wake_mode: 'mentions',
          last_read_seq: 2,
          killed: false
        },
        'backend-dev': {
          conversation_id: '22222222-2222-4222-8222-222222222222',
          model: 'claude-sonnet-4.6',
          role: 'worker',
          wake_mode: 'working',
          last_read_seq: 1,
          killed: false,
          worktree: '/tmp/wt-backend'
        },
        monitor: {
          conversation_id: '44444444-4444-4444-8444-444444444444',
          model: 'gemini-3.1-flash-lite',
          wake_mode: 'mentions',
          last_read_seq: 3,
          killed: false
        },
        reviewer: {
          conversation_id: '33333333-3333-4333-8333-333333333333',
          model: 'gemini-3.1-flash',
          role: 'worker',
          wake_mode: 'mentions',
          last_read_seq: 0,
          killed: true
        }
      }
    })
    const boardJsonl = [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: 'Brief ready @backend-dev please implement token refresh',
        time: '2026-11-16 10:00:00'
      }),
      JSON.stringify({
        seq: 2,
        agent: 'backend-dev',
        text: '@coordinator Done, tests green #api',
        time: '2026-11-16 10:05:00',
        channel: 'api'
      }),
      JSON.stringify({
        seq: 3,
        agent: 'coordinator',
        text: '@all Please verify edge cases',
        time: '2026-11-16 10:06:00'
      })
    ].join('\n')

    const backendTranscript = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        status: 'DONE',
        content: '<USER_REQUEST>\nImplement refresh\n</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: '**Editing token handler**\nChecking expiry',
        tool_calls: [
          {
            name: 'edit_file',
            args: { TargetFile: '/tmp/wt-backend/src/auth.ts' }
          }
        ]
      })
    ].join('\n')

    const snapshot = buildAntigravitySwarmSnapshot({
      swarmId: '11111111-1111-4111-8111-111111111111',
      etag: 'm1|b1',
      membersJson,
      boardJsonl,
      planJson: JSON.stringify({
        goal: { title: 'Auth refactor', line: 'Refresh tokens cleanly' },
        steps: [{ title: 'Implement endpoint', status: 'done' }]
      }),
      transcriptByConversationId: new Map([
        [
          '22222222-2222-4222-8222-222222222222',
          summarizeAntigravityTranscript(backendTranscript, 1_000, 2_000)
        ]
      ]),
      now: 2_000
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot?.title).toBe('Auth refactor swarm')
    expect(snapshot?.headSeq).toBe(3)
    expect(snapshot?.channels).toEqual(['main', 'api'])
    expect(snapshot?.plan?.goal?.title).toBe('Auth refactor')

    // Coordinator sorts first, monitor second, then alphabetical workers.
    expect(snapshot?.members.map((member) => member.name)).toEqual([
      'coordinator',
      'monitor',
      'backend-dev',
      'reviewer'
    ])
    expect(snapshot?.members[0]).toMatchObject({
      name: 'coordinator',
      role: 'coordinator',
      status: 'waiting',
      unread: 1,
      posts: 2
    })
    expect(snapshot?.members[1]).toMatchObject({
      name: 'monitor',
      role: 'monitor',
      status: 'waiting',
      unread: 0
    })
    expect(snapshot?.members[2]).toMatchObject({
      name: 'backend-dev',
      role: 'worker',
      model: 'claude-sonnet-4.6',
      worktree: '/tmp/wt-backend',
      status: 'working',
      activity: 'Edit auth.ts',
      activityKind: 'tool',
      steps: 2,
      posts: 1
    })
    expect(snapshot?.members[3]).toMatchObject({
      name: 'reviewer',
      status: 'killed',
      killed: true
    })

    expect(snapshot?.messages[0]).toMatchObject({
      seq: 1,
      mentions: ['backend-dev'],
      all: false
    })
    expect(snapshot?.messages[2]).toMatchObject({
      seq: 3,
      mentions: [],
      all: true
    })
  })

  it('detects idle state after swarm_wait completes and parses member transcript', () => {
    const transcript = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-16T10:00:00Z',
        content: '<USER_REQUEST>\nAudit auth flow\n</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-16T10:00:05Z',
        thinking: '**Planning audit**',
        content: 'Reading auth files now.',
        tool_calls: [{ name: 'swarm_wait', args: { timeout: 60 } }]
      }),
      JSON.stringify({
        step_index: 2,
        source: 'SYSTEM',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-16T10:01:00Z'
      })
    ].join('\n')

    const summary = summarizeAntigravityTranscript(transcript, 1000, 2000)
    expect(summary.idle).toBe(true)
    expect(summary.replied).toBe(false)

    const entries = parseAntigravityMemberTranscript(transcript)
    expect(entries).toEqual([
      {
        stepIndex: 0,
        kind: 'user',
        text: 'Audit auth flow',
        timestamp: '2026-11-16T10:00:00Z',
        toolCalls: []
      },
      {
        stepIndex: 1,
        kind: 'assistant',
        text: 'Reading auth files now.',
        thinking: '**Planning audit**',
        timestamp: '2026-11-16T10:00:05Z',
        toolCalls: [{ name: 'swarm_wait', label: 'Wait on board' }]
      }
    ])
  })
})
