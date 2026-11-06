import { describe, expect, it } from 'vitest'
import {
  agentStatusSubjectsEqual,
  makePtyAgentStatusSubject,
  makePtyRunAgentStatusSubject,
  makeStructuredAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusExecutionScope
} from './agent-status-subject'
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
  it('isolates identical identities across scope and subject kind', () => {
    const identity = 'identity-1'
    const subjects = [
      makePtyRunAgentStatusSubject(scope(), identity),
      makePtyRunAgentStatusSubject(scope({ wslDistro: 'Ubuntu' }), identity),
      makePtyRunAgentStatusSubject(scope({ executionHostId: 'ssh:target-a' }), identity),
      makePtyRunAgentStatusSubject(scope({ executionHostId: 'runtime:peer-a' }), identity),
      makePtyRunAgentStatusSubject(scope({ workspaceId: 'workspace-2' }), identity),
      makePtyRunAgentStatusSubject(scope({ workspaceKind: 'folder' }), identity),
      makePtyAgentStatusSubject(scope(), identity),
      makeStructuredAgentStatusSubject(scope(), identity)
    ]

    expect(new Set(subjects.map(serializeAgentStatusSubject))).toHaveLength(subjects.length)
    for (const [index, subject] of subjects.entries()) {
      for (const other of subjects.slice(index + 1)) {
        expect(agentStatusSubjectsEqual(subject, other)).toBe(false)
      }
    }
  })

  it('keeps the existing structured-session encoding byte-for-byte stable', () => {
    const serialized = serializeAgentStatusSubject(
      makeStructuredAgentStatusSubject(scope(), SESSION_ID)
    )

    expect(serialized).toBe(
      'agent-status-subject-v1:["structured-session","local",null,"workspace-1","git-worktree","session_11111111-1111-4111-8111-111111111111"]'
    )
  })
})
