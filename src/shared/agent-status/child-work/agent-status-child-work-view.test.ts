import { describe, expect, it } from 'vitest'
import type { AgentChildWorkInput } from './agent-status-child-work'
import { projectAgentChildWorkViews } from './agent-status-child-work-view'
import { makeStructuredAgentStatusSubject } from '../contracts/agent-status-subject'

const SESSION_ID = 'session_11111111-1111-4111-8111-111111111111'
const scope = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'folder-1',
  workspaceKind: 'folder'
} as const
const parent = makeStructuredAgentStatusSubject(scope, SESSION_ID)
const otherParent = makeStructuredAgentStatusSubject(
  { ...scope, workspaceId: 'folder-2' },
  SESSION_ID
)
const FENCE = { invocationId: 'invocation-1', generation: 1 }

function record(childWorkId: string, overrides: Partial<AgentChildWorkInput> = {}) {
  return {
    childWorkId,
    parent,
    provider: 'claude',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 10,
    observedAt: 20,
    stoppable: true,
    invocation: FENCE,
    provenance: { source: 'structured-session', producerId: 'journal-1' },
    ...overrides
  } satisfies AgentChildWorkInput
}

describe('projectAgentChildWorkViews', () => {
  it('keeps an owner only when it is present, in the same session, and not on a cycle', () => {
    const views = projectAgentChildWorkViews(
      [
        record('owner'),
        record('shell', { kind: 'command', parentChildWorkId: 'owner' }),
        record('orphan', { kind: 'command', parentChildWorkId: 'removed' }),
        record('elsewhere', { parent: otherParent }),
        record('cross', { kind: 'command', parentChildWorkId: 'elsewhere' }),
        record('cycle-a', { parentChildWorkId: 'cycle-b' }),
        record('cycle-b', { parentChildWorkId: 'cycle-a' }),
        record('into-cycle', { kind: 'command', parentChildWorkId: 'cycle-a' })
      ],
      []
    )
    expect(Object.fromEntries(views.map((view) => [view.id, view.parentChildWorkId]))).toEqual({
      owner: undefined,
      shell: 'owner',
      orphan: undefined,
      elsewhere: undefined,
      cross: undefined,
      'cycle-a': undefined,
      'cycle-b': undefined,
      'into-cycle': 'cycle-a'
    })
  })
})
