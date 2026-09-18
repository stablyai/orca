// Arranging the offer, and the one rule selection must never break.
//
// Checking a box changes WHICH eligible chats are acted on. It can never change what is eligible,
// and it can never introduce a chat the host did not offer.

import { describe, expect, it } from 'vitest'
import {
  allResumeSessionIds,
  groupResumeCandidates,
  groupResumeWorkspacesByRepo,
  resolveResumeGroupHeader,
  resumeWorkspaceKind,
  selectedResumeSessionIds,
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

describe('selecting which offered chats to act on', () => {
  it('defaults to every chat the host offered', () => {
    const offered = [candidate(), candidate({ sessionId: 'session-2' })]

    expect(allResumeSessionIds(offered)).toEqual(['session-1', 'session-2'])
  })

  it('acts only on the chats that are checked', () => {
    const offered = [candidate(), candidate({ sessionId: 'session-2' })]

    expect(selectedResumeSessionIds(offered, new Set(['session-2']))).toEqual(['session-2'])
  })

  // THE SAFETY RULE. A selection is intersected against the offer, so a stale or invented id cannot
  // reach an action. The host re-derives the predicate regardless; this keeps the client honest too.
  it('drops any selected id the host did not offer', () => {
    const offered = [candidate()]

    expect(
      selectedResumeSessionIds(offered, new Set(['session-1', 'session-never-offered']))
    ).toEqual(['session-1'])
  })

  it('acts on nothing when nothing is checked', () => {
    expect(selectedResumeSessionIds([candidate()], new Set())).toEqual([])
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
