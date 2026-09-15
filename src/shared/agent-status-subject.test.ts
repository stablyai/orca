import { describe, expect, it } from 'vitest'
import {
  agentStatusSubjectsEqual,
  deserializeAgentStatusSubject,
  makePtyAgentStatusSubject,
  makePtyRunAgentStatusSubject,
  makeStructuredAgentStatusSubject,
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusExecutionScope
} from './agent-status-subject'

const RUN_ID = 'run_11111111-1111-4111-8111-111111111111'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'

function scope(overrides: Partial<AgentStatusExecutionScope> = {}): AgentStatusExecutionScope {
  return {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree',
    ...overrides
  }
}

describe('agent status subjects', () => {
  it('round-trips every subject kind', () => {
    const subjects = [
      makePtyRunAgentStatusSubject(scope(), RUN_ID),
      makePtyAgentStatusSubject(scope(), PANE_KEY),
      makeStructuredAgentStatusSubject(scope(), SESSION_ID)
    ]

    for (const subject of subjects) {
      const serialized = serializeAgentStatusSubject(subject)
      expect(deserializeAgentStatusSubject(serialized)).toEqual(subject)
      expect(agentStatusSubjectsEqual(subject, { ...subject })).toBe(true)
    }
  })

  it('isolates identical identities across scope and subject kind', () => {
    const identity = 'identity-1'

    const subjects = [
      makePtyRunAgentStatusSubject(scope(), identity),
      makePtyRunAgentStatusSubject(scope({ wslDistro: 'Ubuntu' }), identity),
      makePtyRunAgentStatusSubject(scope({ executionHostId: 'ssh:target-a' }), identity),
      makePtyRunAgentStatusSubject(scope({ executionHostId: 'runtime:peer-a' }), identity),
      makePtyRunAgentStatusSubject(
        scope({ workspaceId: 'folder-1', workspaceKind: 'folder' }),
        identity
      ),
      makePtyAgentStatusSubject(scope(), identity),
      makeStructuredAgentStatusSubject(scope(), identity)
    ]

    expect(new Set(subjects.map(serializeAgentStatusSubject))).toHaveLength(subjects.length)
  })

  it('keeps the existing structured-session encoding byte-for-byte stable', () => {
    const serialized = serializeAgentStatusSubject(
      makeStructuredAgentStatusSubject(scope(), SESSION_ID)
    )

    expect(serialized).toBe(
      'agent-status-subject-v1:["structured-session","local",null,"workspace-1","git-worktree","session_11111111-1111-4111-8111-111111111111"]'
    )
  })

  it.each([
    null,
    { kind: 'future' },
    {
      kind: 'pty-run',
      ...scope(),
      runId: `${RUN_ID} `
    },
    {
      kind: 'pty-run',
      ...scope(),
      runId: `${RUN_ID}\nforged`
    },
    {
      kind: 'pty',
      ...scope(),
      paneKey: PANE_KEY,
      runId: RUN_ID
    },
    {
      kind: 'structured-session',
      ...scope(),
      sessionId: 'short'
    },
    {
      kind: 'pty',
      ...scope(),
      executionHostId: 'target-a',
      paneKey: PANE_KEY
    },
    {
      kind: 'pty',
      ...scope({ executionHostId: 'ssh:%74arget-a' }),
      paneKey: PANE_KEY
    },
    {
      kind: 'pty',
      ...scope({ executionHostId: 'ssh:target-a', wslDistro: 'Ubuntu' }),
      paneKey: PANE_KEY
    },
    {
      kind: 'pty',
      ...scope({ executionHostId: `ssh:${'x'.repeat(513)}` }),
      paneKey: PANE_KEY
    },
    {
      kind: 'pty',
      ...scope({ workspaceId: 'workspace\0forged' }),
      paneKey: PANE_KEY
    }
  ])('rejects malformed subject %#', (value) => {
    expect(parseAgentStatusSubject(value)).toBeNull()
  })

  it.each([
    '',
    'agent-status-subject-v1:not-json',
    'agent-status-subject-v1:["pty-run","local",null,"workspace-1","git-worktree"]',
    'agent-status-subject-v1:["unknown","local",null,"workspace-1","git-worktree","id"]'
  ])('rejects malformed serialized subject %#', (value) => {
    expect(deserializeAgentStatusSubject(value)).toBeNull()
  })
})
