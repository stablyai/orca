import { describe, expect, it } from 'vitest'
import {
  groupResumeCandidatesByHost,
  nestResumeWorkspaces,
  resumeWorkspaceCandidates,
  type ResumeCandidate
} from './native-chat-resume-on-restart-grouping'

const NOW = 1_700_000_000_000

function candidate(overrides: Partial<ResumeCandidate> = {}): ResumeCandidate {
  return {
    sessionId: 'session-1',
    workspaceId: 'repo-1::/w/one',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: 'fix the auth bug',
    recordedAt: NOW,
    executionHostId: 'local',
    workspaceKind: 'git-worktree',
    ...overrides
  }
}

describe('nesting child workspaces', () => {
  const group = (workspaceId: string) => ({ workspaceId, candidates: [] })
  const nestedWorkspaceIds = (nodes: ReturnType<typeof nestResumeWorkspaces>): unknown =>
    nodes.map((node) => [node.group.workspaceId, nestedWorkspaceIds(node.children)])

  it('puts a child under its nearest listed ancestor, skipping one with nothing to resume', () => {
    const ancestors: Record<string, string[]> = { grandchild: ['child', 'parent'], parent: [] }
    const nested = nestResumeWorkspaces(
      [group('grandchild'), group('other'), group('parent')],
      (id) => ancestors[id] ?? []
    )

    expect(nestedWorkspaceIds(nested)).toEqual([
      ['other', []],
      ['parent', [['grandchild', []]]]
    ])
  })

  it('places every workspace when ancestors loop', () => {
    const ancestors: Record<string, string[]> = { a: ['b'], b: ['a'], c: ['a'] }
    const nested = nestResumeWorkspaces(
      [group('a'), group('b'), group('c'), group('d')],
      (id) => ancestors[id] ?? []
    )

    expect(nestedWorkspaceIds(nested)).toEqual([
      [
        'a',
        [
          ['b', []],
          ['c', []]
        ]
      ],
      ['d', []]
    ])
  })
})

describe('group checkboxes', () => {
  it('covers a workspace and every workspace nested under it', () => {
    const chats = (workspaceId: string, ...sessionIds: string[]) => ({
      workspaceId,
      candidates: sessionIds.map((sessionId) => candidate({ sessionId, workspaceId }))
    })
    const [root] = nestResumeWorkspaces(
      [chats('parent', 'p1'), chats('child', 'c1', 'c2'), chats('grandchild', 'g1')],
      (id) => ({ child: ['parent'], grandchild: ['child', 'parent'] })[id] ?? []
    )

    expect(resumeWorkspaceCandidates(root!).map((entry) => entry.sessionId)).toEqual([
      'p1',
      'c1',
      'c2',
      'g1'
    ])
  })
})

describe('grouping by machine', () => {
  it('groups by host in first-seen order, a missing host id counting as this machine', () => {
    const groups = groupResumeCandidatesByHost([
      candidate({ sessionId: 'a', executionHostId: 'ssh:box' }),
      candidate({ sessionId: 'b', executionHostId: undefined }),
      candidate({ sessionId: 'c', executionHostId: 'ssh:box' }),
      candidate({ sessionId: 'd', executionHostId: 'local' })
    ])

    expect(
      groups.map((group) => [group.hostId, group.candidates.map((entry) => entry.sessionId)])
    ).toEqual([
      ['ssh:box', ['a', 'c']],
      ['local', ['b', 'd']]
    ])
  })
})
