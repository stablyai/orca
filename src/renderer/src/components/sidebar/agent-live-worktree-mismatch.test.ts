import { describe, expect, it } from 'vitest'
import {
  attachAgentLiveWorktreeMismatch,
  buildAgentLiveWorktreeMismatchCandidates,
  resolveAgentLiveWorktreeMismatch,
  type AgentLiveWorktreeMismatchCandidate
} from './agent-live-worktree-mismatch'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Repo,
  TerminalTab,
  Worktree
} from '../../../../shared/types'

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: '/repo',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local',
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    name: 'repo',
    path: '/repo',
    kind: 'git',
    ...overrides
  } as Repo
}

function makeDetected(
  worktrees: Worktree[],
  authorityByHostId: DetectedWorktreeListResult['authorityByHostId'],
  ownership: DetectedWorktree['ownership'] = 'agent-scratch'
): DetectedWorktreeListResult {
  return {
    repoId: worktrees[0]?.repoId ?? 'repo-1',
    authoritative: true,
    source: 'git',
    authorityByHostId,
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership,
      selectedCheckout: false,
      visible: false
    }))
  }
}

function candidate(
  worktree: Worktree,
  overrides: Partial<AgentLiveWorktreeMismatchCandidate> = {}
): AgentLiveWorktreeMismatchCandidate {
  return { ...worktree, visible: true, ...overrides }
}

const OWNER = makeWorktree({
  id: 'repo-1::/repo',
  repoId: 'repo-1',
  path: '/repo',
  branch: 'refs/heads/main',
  displayName: 'main'
})
const OWNER_REPO = makeRepo({ id: 'repo-1' })
const SCRATCH = makeWorktree({
  id: 'repo-1::/repo/.claude/worktrees/scratch',
  repoId: 'repo-1',
  path: '/repo/.claude/worktrees/scratch',
  branch: 'refs/heads/10572-live-repro',
  displayName: 'scratch'
})

function resolve(
  reportedCwd: string | undefined,
  candidates: AgentLiveWorktreeMismatchCandidate[],
  owner: Worktree = OWNER,
  repo: Repo = OWNER_REPO
) {
  return resolveAgentLiveWorktreeMismatch({
    reportedCwd,
    ownerWorktree: owner,
    ownerRepo: repo,
    candidates
  })
}

describe('resolveAgentLiveWorktreeMismatch', () => {
  it('resolves a nested scratch destination over the owner checkout', () => {
    expect(
      resolve('/repo/.claude/worktrees/scratch/src', [candidate(OWNER), candidate(SCRATCH)])
    ).toEqual({
      destinationWorktreeId: SCRATCH.id,
      destinationLabel: '10572-live-repro'
    })
  })

  it('returns no mismatch for the owner checkout, unknown paths, and folder workspaces', () => {
    expect(resolve('/repo/src', [candidate(OWNER), candidate(SCRATCH)])).toBeNull()
    expect(resolve('/repo', [candidate(OWNER), candidate(SCRATCH)])).toBeNull()
    expect(resolve('/elsewhere/checkout', [candidate(OWNER), candidate(SCRATCH)])).toBeNull()
    expect(resolve(undefined, [candidate(OWNER), candidate(SCRATCH)])).toBeNull()
    expect(
      resolve('/repo/.claude/worktrees/scratch', [candidate(OWNER), candidate(SCRATCH)], OWNER, {
        ...OWNER_REPO,
        kind: 'folder'
      } as Repo)
    ).toBeNull()
  })

  it('fails closed on invalid host provenance', () => {
    const unparseable = { ...OWNER, hostId: 'ssh:' as Worktree['hostId'] }
    expect(resolve('/repo/.claude/worktrees/scratch', [candidate(SCRATCH)], unparseable)).toBeNull()
    // Why: a candidate with no stable host identity carries ambiguous provenance.
    expect(
      resolve('/repo/.claude/worktrees/scratch', [
        candidate({ ...SCRATCH, hostId: undefined } as Worktree)
      ])
    ).toBeNull()
  })

  it('never matches a repo, worktree id, or prior id from another host', () => {
    const sshOwner = makeWorktree({
      id: 'repo-1::/repo',
      repoId: 'repo-1',
      path: '/repo',
      hostId: 'ssh:target-a'
    })
    const sameIdOtherHost = makeWorktree({
      id: SCRATCH.id,
      repoId: 'repo-1',
      path: '/repo/.claude/worktrees/scratch',
      hostId: 'ssh:target-b'
    })
    expect(
      resolve('/repo/.claude/worktrees/scratch', [candidate(sameIdOtherHost)], sshOwner)
    ).toBeNull()
    // Why: matching is by current path only; a renamed folder's old id must not match.
    const renamed = makeWorktree({
      id: 'repo-1::/repo/.claude/worktrees/renamed',
      repoId: 'repo-1',
      path: '/repo/.claude/worktrees/renamed',
      priorWorktreeIds: ['repo-1::/repo/.claude/worktrees/old'],
      branch: 'refs/heads/renamed'
    })
    expect(
      resolve('/repo/.claude/worktrees/old', [candidate(OWNER), candidate(renamed)])
    ).toBeNull()
  })

  it('rejects a candidate from another repo bucket', () => {
    const otherRepo = makeWorktree({
      id: 'repo-2::/repo/.claude/worktrees/scratch',
      repoId: 'repo-2',
      path: '/repo/.claude/worktrees/scratch'
    })
    expect(resolve('/repo/.claude/worktrees/scratch', [candidate(otherRepo)])).toBeNull()
  })

  it('keeps SSH matching stable across connection-id churn', () => {
    const sshOwner = makeWorktree({
      id: 'repo-1::/repo',
      repoId: 'repo-1',
      path: '/repo',
      hostId: 'ssh:target-a'
    })
    const sshScratch = makeWorktree({
      id: 'repo-1::/repo/scratch',
      repoId: 'repo-1',
      path: '/repo/scratch',
      branch: 'refs/heads/scratch',
      hostId: 'ssh:target-a'
    })
    const sshRepo = makeRepo({ id: 'repo-1', connectionId: 'conn-9' } as Partial<Repo> & {
      id: string
    })
    expect(resolve('/repo/scratch', [candidate(sshScratch)], sshOwner, sshRepo)).toEqual({
      destinationWorktreeId: sshScratch.id,
      destinationLabel: 'scratch'
    })
  })

  it('matches a paired-runtime worktree by its runtime catalog scope and SSH filesystem host', () => {
    const pairedOwner = makeWorktree({
      id: 'repo-1::/repo',
      repoId: 'repo-1',
      path: '/repo',
      hostId: 'ssh:target-a',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const pairedScratch = makeWorktree({
      id: 'repo-1::/repo/scratch',
      repoId: 'repo-1',
      path: '/repo/scratch',
      branch: 'refs/heads/scratch',
      hostId: 'ssh:target-a',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    const unpaired = makeWorktree({
      id: 'repo-1::/repo/scratch-b',
      repoId: 'repo-1',
      path: '/repo/scratch',
      branch: 'refs/heads/scratch-b',
      hostId: 'ssh:target-a'
    })
    expect(
      resolve('/repo/scratch', [candidate(pairedScratch), candidate(unpaired)], pairedOwner)
    ).toEqual({ destinationWorktreeId: pairedScratch.id, destinationLabel: 'scratch' })
  })

  it('applies POSIX case sensitivity and Windows case folding', () => {
    const posixScratch = makeWorktree({
      id: 'repo-1::/repo/Scratch',
      repoId: 'repo-1',
      path: '/repo/Scratch',
      branch: 'refs/heads/scratch'
    })
    expect(resolve('/repo/scratch/src', [candidate(OWNER), candidate(posixScratch)])).toBeNull()

    const winOwner = makeWorktree({ id: 'repo-1::C:\\repo', repoId: 'repo-1', path: 'C:\\repo' })
    const winScratch = makeWorktree({
      id: 'repo-1::C:\\repo\\Scratch',
      repoId: 'repo-1',
      path: 'C:\\repo\\Scratch',
      branch: 'refs/heads/win-scratch'
    })
    expect(
      resolve('c:/REPO/scratch/src', [candidate(winOwner), candidate(winScratch)], winOwner)
    ).toEqual({ destinationWorktreeId: winScratch.id, destinationLabel: 'win-scratch' })
  })

  it('collapses dot segments, duplicate and trailing separators', () => {
    expect(
      resolve('/repo/./.claude//worktrees/other/../scratch/', [
        candidate(OWNER),
        candidate(SCRATCH)
      ])
    ).toEqual({ destinationWorktreeId: SCRATCH.id, destinationLabel: '10572-live-repro' })
  })

  it('only matches at a segment boundary', () => {
    expect(
      resolve('/repo/.claude/worktrees/scratch-2/src', [candidate(OWNER), candidate(SCRATCH)])
    ).toBeNull()
  })

  it('prefers the longest current root and refuses equal-root ambiguity', () => {
    const nested = makeWorktree({
      id: 'repo-1::/repo/.claude/worktrees/scratch/nested',
      repoId: 'repo-1',
      path: '/repo/.claude/worktrees/scratch/nested',
      branch: 'refs/heads/nested'
    })
    expect(
      resolve('/repo/.claude/worktrees/scratch/nested/src', [
        candidate(OWNER),
        candidate(SCRATCH),
        candidate(nested)
      ])
    ).toEqual({ destinationWorktreeId: nested.id, destinationLabel: 'nested' })

    const duplicatePath = makeWorktree({
      id: 'repo-1::/repo/.claude/worktrees/scratch#2',
      repoId: 'repo-1',
      path: '/repo/.claude/worktrees/scratch',
      branch: 'refs/heads/other'
    })
    expect(
      resolve('/repo/.claude/worktrees/scratch/src', [candidate(SCRATCH), candidate(duplicatePath)])
    ).toBeNull()
  })

  it('bridges a Linux path into the matching WSL distro only', () => {
    const wslOwner = makeWorktree({
      id: 'repo-1::wsl-owner',
      repoId: 'repo-1',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
    })
    const wslScratch = makeWorktree({
      id: 'repo-1::wsl-scratch',
      repoId: 'repo-1',
      path: '\\\\wsl$\\ubuntu\\home\\dev\\repo\\scratch',
      branch: 'refs/heads/wsl-scratch'
    })
    const otherDistro = makeWorktree({
      id: 'repo-1::wsl-other',
      repoId: 'repo-1',
      path: '\\\\wsl.localhost\\Debian\\home\\dev\\repo\\scratch',
      branch: 'refs/heads/debian-scratch'
    })
    expect(
      resolve('/home/dev/repo/scratch/src', [candidate(wslOwner), candidate(wslScratch)], wslOwner)
    ).toEqual({ destinationWorktreeId: wslScratch.id, destinationLabel: 'wsl-scratch' })
    // Why: the distro alias folds case, the Linux tail does not.
    expect(resolve('/home/dev/repo/Scratch', [candidate(wslScratch)], wslOwner)).toBeNull()
    expect(
      resolve(
        '\\\\wsl.localhost\\Debian\\home\\dev\\repo\\scratch',
        [candidate(wslScratch)],
        wslOwner
      )
    ).toBeNull()
    // Why: a bare Linux cwd only bridges into the owner's proven distro.
    expect(resolve('/home/dev/repo/scratch', [candidate(otherDistro)], wslOwner)).toBeNull()
    expect(
      resolve('/home/dev/repo/scratch', [candidate(wslScratch), candidate(otherDistro)], wslOwner)
    ).toEqual({ destinationWorktreeId: wslScratch.id, destinationLabel: 'wsl-scratch' })
    // Why: no owner distro proof means a bare Linux path matches no UNC root.
    const windowsOwner = makeWorktree({
      id: 'repo-1::C:\\repo',
      repoId: 'repo-1',
      path: 'C:\\repo'
    })
    expect(resolve('/home/dev/repo/scratch', [candidate(wslScratch)], windowsOwner)).toBeNull()
  })

  it('falls back from branch to display name to path basename for the label', () => {
    const noBranch: Worktree = { ...SCRATCH, branch: '' }
    expect(
      resolve('/repo/.claude/worktrees/scratch', [candidate(noBranch)])?.destinationLabel
    ).toBe('scratch')
    const noNames: Worktree = { ...SCRATCH, branch: '', displayName: '' }
    expect(resolve('/repo/.claude/worktrees/scratch', [candidate(noNames)])?.destinationLabel).toBe(
      'scratch'
    )
  })
})

describe('buildAgentLiveWorktreeMismatchCandidates', () => {
  const detectedScratch = makeWorktree({
    id: 'repo-1::/repo/.claude/worktrees/hidden',
    repoId: 'repo-1',
    path: '/repo/.claude/worktrees/hidden',
    branch: 'refs/heads/hidden'
  })

  it('admits hidden detected rows only under an authoritative refresh for the owner scope', () => {
    const authoritative = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER],
      detected: makeDetected([detectedScratch], { local: { authoritative: true, source: 'git' } })
    })
    expect(authoritative.map((c) => c.id)).toContain(detectedScratch.id)
    expect(authoritative.find((c) => c.id === detectedScratch.id)?.visible).toBe(false)

    const revoked = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER],
      detected: makeDetected([detectedScratch], {
        local: { authoritative: false, source: 'session-fallback' }
      })
    })
    expect(revoked.map((c) => c.id)).not.toContain(detectedScratch.id)
  })

  it('does not let another scope authorize this scope hidden rows in a merged bucket', () => {
    const merged = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER],
      detected: makeDetected([detectedScratch], {
        'ssh:target-a': { authoritative: true, source: 'git' },
        local: { authoritative: false, source: 'metadata-fallback' }
      })
    })
    expect(merged.map((c) => c.id)).not.toContain(detectedScratch.id)
  })

  it('keeps visible rows eligible without borrowing detected visibility', () => {
    const visibleTwin = { ...detectedScratch }
    const candidates = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER, visibleTwin],
      detected: makeDetected([detectedScratch], {
        local: { authoritative: true, source: 'git' }
      })
    })
    expect(candidates.filter((c) => c.id === detectedScratch.id)).toHaveLength(1)
    expect(candidates.find((c) => c.id === detectedScratch.id)?.visible).toBe(true)
  })

  it('returns nothing for folder workspaces', () => {
    expect(
      buildAgentLiveWorktreeMismatchCandidates({
        ownerWorktree: OWNER,
        ownerRepo: { ...OWNER_REPO, kind: 'folder' } as Repo,
        visibleWorktrees: [OWNER],
        detected: undefined
      })
    ).toEqual([])
  })
})

describe('attachAgentLiveWorktreeMismatch', () => {
  function makeRow(
    overrides: Omit<Partial<DashboardAgentRow>, 'entry'> & {
      paneKey: string
      entry?: Partial<AgentStatusEntry>
    }
  ): DashboardAgentRow {
    const entry = {
      paneKey: overrides.paneKey,
      state: 'working',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      agentType: 'claude',
      ...overrides.entry
    } as AgentStatusEntry
    return {
      tab: { id: 'tab-1', worktreeId: OWNER.id } as TerminalTab,
      agentType: 'claude',
      rowSource: 'live',
      state: 'working',
      startedAt: 1,
      ...overrides,
      entry
    }
  }

  const args = {
    ownerWorktree: OWNER,
    ownerRepo: OWNER_REPO,
    candidates: [candidate(OWNER), candidate(SCRATCH)]
  }

  it('annotates only live rows carrying a reported location', () => {
    const rows = [
      makeRow({
        paneKey: 'tab-1:pane-a',
        entry: { reportedCwd: '/repo/.claude/worktrees/scratch' } as Partial<AgentStatusEntry>
      }),
      makeRow({ paneKey: 'tab-1:pane-b' }),
      makeRow({
        paneKey: 'tab-1:pane-c',
        rowSource: 'retained',
        entry: { reportedCwd: '/repo/.claude/worktrees/scratch' } as Partial<AgentStatusEntry>
      }),
      makeRow({
        paneKey: 'tab-1:pane-a#child',
        rowSource: 'subagent',
        activationPaneKey: 'tab-1:pane-a',
        entry: { reportedCwd: '/repo/.claude/worktrees/scratch' } as Partial<AgentStatusEntry>
      })
    ]
    const next = attachAgentLiveWorktreeMismatch(rows, args)
    expect(next[0].liveWorktreeMismatch?.destinationLabel).toBe('10572-live-repro')
    expect(next[1].liveWorktreeMismatch).toBeUndefined()
    expect(next[2].liveWorktreeMismatch).toBeUndefined()
    expect(next[3].liveWorktreeMismatch).toBeUndefined()
  })

  it('returns the original array when no row resolves a mismatch', () => {
    const rows = [
      makeRow({
        paneKey: 'tab-1:pane-a',
        entry: { reportedCwd: '/repo/src' } as Partial<AgentStatusEntry>
      })
    ]
    expect(attachAgentLiveWorktreeMismatch(rows, args)).toBe(rows)
  })

  it('starts annotating the same row once the destination is discovered', () => {
    const rows = [
      makeRow({
        paneKey: 'tab-1:pane-a',
        entry: { reportedCwd: '/repo/.claude/worktrees/scratch' } as Partial<AgentStatusEntry>
      })
    ]
    // Why: the scratch checkout usually appears in a later catalog refresh than
    // the hook event that first reports its path.
    const beforeDiscovery = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER],
      detected: undefined
    })
    expect(
      attachAgentLiveWorktreeMismatch(rows, {
        ownerWorktree: OWNER,
        ownerRepo: OWNER_REPO,
        candidates: beforeDiscovery
      })[0].liveWorktreeMismatch
    ).toBeUndefined()

    const afterDiscovery = buildAgentLiveWorktreeMismatchCandidates({
      ownerWorktree: OWNER,
      ownerRepo: OWNER_REPO,
      visibleWorktrees: [OWNER],
      detected: makeDetected([SCRATCH], { local: { authoritative: true, source: 'git' } })
    })
    expect(
      attachAgentLiveWorktreeMismatch(rows, {
        ownerWorktree: OWNER,
        ownerRepo: OWNER_REPO,
        candidates: afterDiscovery
      })[0].liveWorktreeMismatch?.destinationLabel
    ).toBe('10572-live-repro')
  })
})
