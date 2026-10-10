// Arranging the offer for display: which ids it covers, and how the rows nest.

import { describe, expect, it } from 'vitest'
import {
  allResumeSessionIds,
  groupResumeCandidates,
  groupResumeCandidatesByHost,
  groupResumeWorkspacesByRepo,
  nestResumeWorkspaces,
  resolveResumeGroupHeader,
  resumeSelectionState,
  resumeWorkspaceKind,
  resumeWorkspaceCandidates,
  toggleResumeSelection,
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

describe('naming every offered chat', () => {
  it('keeps the order the host offered', () => {
    const offered = [candidate(), candidate({ sessionId: 'session-2' })]

    expect(allResumeSessionIds(offered)).toEqual(['session-1', 'session-2'])
  })
})

describe('arranging the offer the way the sidebar does', () => {
  it('groups chats by workspace in the order the host offered them', () => {
    const groups = groupResumeCandidates([
      candidate({ sessionId: 'a', workspaceId: 'repo-1::/w/one' }),
      candidate({ sessionId: 'b', workspaceId: 'repo-1::/w/two' }),
      candidate({ sessionId: 'c', workspaceId: 'repo-1::/w/one' })
    ])

    expect(groups.map((group) => group.workspaceId)).toEqual(['repo-1::/w/one', 'repo-1::/w/two'])
    expect(groups[0]?.candidates.map((entry) => entry.sessionId)).toEqual(['a', 'c'])
  })

  it('groups workspaces under the repo each belongs to', () => {
    const workspaces = groupResumeCandidates([
      candidate({ sessionId: 'a', workspaceId: 'repo-1::/w/one' }),
      candidate({ sessionId: 'b', workspaceId: 'repo-2::/w/two' }),
      candidate({ sessionId: 'c', workspaceId: 'repo-1::/w/three' })
    ])

    const repoGroups = groupResumeWorkspacesByRepo(workspaces, (id) => id.split('::')[0] ?? null)

    expect(repoGroups.map((group) => group.repoId)).toEqual(['repo-1', 'repo-2'])
    expect(repoGroups[0]?.workspaces).toHaveLength(2)
  })

  // Workspaces with no repo share one group rather than each inventing a header of its own.
  it('collects workspaces with no repo into a single group', () => {
    const workspaces = groupResumeCandidates([
      candidate({ sessionId: 'a', workspaceId: 'folder:aaa' }),
      candidate({ sessionId: 'b', workspaceId: 'folder:bbb' })
    ])

    const repoGroups = groupResumeWorkspacesByRepo(workspaces, () => null)

    expect(repoGroups).toHaveLength(1)
    expect(repoGroups[0]?.repoId).toBeNull()
    expect(repoGroups[0]?.workspaces).toHaveLength(2)
  })
})

describe('choosing the workspace glyph', () => {
  // The host read the kind off the durable record, so it wins over any shape-guessing.
  it('uses the kind the host recorded', () => {
    expect(resumeWorkspaceKind(candidate({ workspaceKind: 'folder' }))).toBe('folder')
    expect(resumeWorkspaceKind(candidate({ workspaceKind: 'git-worktree' }))).toBe('git-worktree')
  })

  // An older host sends no kind; the id space still separates the two, and it is never guessed
  // from a display name.
  it.each([
    ['folder:0f8f-aaa', 'folder'],
    ['repo-1::/w/one', 'git-worktree']
  ] as const)('falls back to the id shape for %s', (workspaceId, expected) => {
    const { workspaceKind: _dropped, ...withoutKind } = candidate({ workspaceId })

    expect(resumeWorkspaceKind(withoutKind)).toBe(expected)
  })
})

describe('naming the group header', () => {
  const REPO_ICON = { type: 'lucide', name: 'git-branch' } as const
  const REPOS = [{ id: 'repo-1', displayName: 'orca', repoIcon: REPO_ICON }]
  const GROUPS = [{ id: '4c3c3452-758b-418b-add1-0a280c8e03a0', name: 'Scratch' }]

  // THE REGRESSION. A folder workspace's repoId is `folder-workspace:<projectGroupId>` and is never
  // null, so the old "repoId !== null means it is a repo" test took the repo branch, found nothing
  // in the repos list, and printed the raw synthetic id — a uuid — as the header.
  it('titles a folder workspace with its project group name, not the raw id', () => {
    const header = resolveResumeGroupHeader(
      'folder-workspace:4c3c3452-758b-418b-add1-0a280c8e03a0',
      REPOS,
      GROUPS
    )

    expect(header).toEqual({ kind: 'project', name: 'Scratch' })
    expect(header.name).not.toContain('folder-workspace:')
    expect(header.name).not.toContain('4c3c3452')
  })

  it('titles a git repo with its display name and keeps its own glyph', () => {
    expect(resolveResumeGroupHeader('repo-1', REPOS, GROUPS)).toEqual({
      kind: 'repo',
      name: 'orca',
      repoIcon: REPO_ICON
    })
  })

  // An unknown project group still reads as a project, so it takes the group glyph rather than
  // falling back into the repo branch.
  it('still reports a project for a group it cannot find', () => {
    const header = resolveResumeGroupHeader('folder-workspace:missing', REPOS, GROUPS)

    expect(header.kind).toBe('project')
  })
})

describe('nesting child workspaces', () => {
  const group = (workspaceId: string) => ({ workspaceId, candidates: [] })
  const nestedWorkspaceIds = (nodes: ReturnType<typeof nestResumeWorkspaces>): unknown =>
    nodes.map((node) => [node.group.workspaceId, nestedWorkspaceIds(node.children)])

  it('puts a child under its nearest listed ancestor, skipping one with nothing to resume', () => {
    // grandchild -> child (not listed) -> parent
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

  it('keeps a child whose ancestors are all unlisted at the top, in offer order', () => {
    const nested = nestResumeWorkspaces([group('a'), group('b')], () => ['elsewhere'])

    expect(nestedWorkspaceIds(nested)).toEqual([
      ['a', []],
      ['b', []]
    ])
  })

  // Lineage from two hosts can disagree; a chat under no root would be resumed without being seen.
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

  it.each([
    [['a', 'b'], true, 2],
    [['a'], 'indeterminate', 1],
    [[], false, 0]
  ] as const)('with %j ticked reads %s', (ticked, checked, selectedCount) => {
    expect(resumeSelectionState(['a', 'b'], new Set(ticked))).toEqual({
      checked,
      selectedCount,
      total: 2
    })
  })

  it('reads unchecked when it covers nothing', () => {
    expect(resumeSelectionState([], new Set(['a'])).checked).toBe(false)
  })

  it('ticks everything unless everything is ticked, then unticks it', () => {
    const calls: [string, boolean][] = []
    const record = (sessionId: string, checked: boolean) => calls.push([sessionId, checked])
    toggleResumeSelection(['a', 'b'], resumeSelectionState(['a', 'b'], new Set(['a'])), record)
    toggleResumeSelection(['a', 'b'], resumeSelectionState(['a', 'b'], new Set(['a', 'b'])), record)

    expect(calls).toEqual([
      ['a', true],
      ['b', true],
      ['a', false],
      ['b', false]
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
