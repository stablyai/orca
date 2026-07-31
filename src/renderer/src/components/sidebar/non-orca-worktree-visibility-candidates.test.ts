import { describe, expect, it } from 'vitest'

import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from '../../../../shared/types'
import { getNewExternalWorktreeInboxWorktrees } from '../../../../shared/external-worktree-inbox'
import {
  buildAgentWorktreeRows,
  buildOtherWorktreeRows,
  hiddenPathsForKind,
  importedPathsAfterHidingKind,
  summarizeAgentWorktreeVisibility,
  summarizeNonOrcaWorktreeRows,
  summarizeOtherWorktreeVisibility
} from './non-orca-worktree-visibility-candidates'

const SCRATCH_PATH = '/repo/.claude/worktrees/scratch-1'
const EXTERNAL_PATH = '/elsewhere/manual'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: Date.UTC(2026, 4, 24),
    externalWorktreeVisibility: 'hide',
    externalWorktreeVisibilityPromptDismissedAt: 1,
    ...overrides
  }
}

function detectedWorktree(overrides: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: `repo-1::${overrides.path ?? EXTERNAL_PATH}`,
    repoId: 'repo-1',
    path: EXTERNAL_PATH,
    displayName: 'manual',
    branch: 'refs/heads/feature',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ownership: 'external',
    selectedCheckout: false,
    visible: false,
    ...overrides
  } as DetectedWorktree
}

function detectedResult(
  worktrees: DetectedWorktree[],
  overrides: Partial<DetectedWorktreeListResult> = {}
): DetectedWorktreeListResult {
  return {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees,
    ...overrides
  }
}

const scratch = detectedWorktree({
  path: SCRATCH_PATH,
  displayName: 'scratch-1',
  ownership: 'agent-scratch'
})

describe('agent worktree rows', () => {
  it('offers baselined agent scratch the inbox has stopped notifying about', () => {
    const detected = detectedResult([scratch])
    const baselinedRepo = makeRepo({ externalWorktreeInboxBaselinePaths: [SCRATCH_PATH] })

    expect(getNewExternalWorktreeInboxWorktrees(detected, baselinedRepo)).toEqual([])
    expect(buildAgentWorktreeRows(detected, makeRepo())).toEqual([
      {
        id: scratch.id,
        displayName: 'scratch-1',
        path: SCRATCH_PATH,
        displayPath: '.claude/worktrees/scratch-1',
        visible: false
      }
    ])
  })

  it('keeps visible scratch listed so an import can be undone from the same place', () => {
    const detected = detectedResult([{ ...scratch, visible: true }])

    expect(buildAgentWorktreeRows(detected, makeRepo())).toEqual([
      {
        id: scratch.id,
        displayName: 'scratch-1',
        path: SCRATCH_PATH,
        displayPath: '.claude/worktrees/scratch-1',
        visible: true
      }
    ])
  })

  it('excludes other ownerships and the selected checkout', () => {
    const detected = detectedResult([
      detectedWorktree(),
      detectedWorktree({ path: '/orca/managed', ownership: 'orca-managed' }),
      detectedWorktree({
        path: '/repo/.claude/worktrees/checked-out',
        ownership: 'agent-scratch',
        selectedCheckout: true,
        visible: true
      })
    ])

    expect(buildAgentWorktreeRows(detected, makeRepo())).toEqual([])
  })

  it('lists nothing while the detected snapshot is not authoritative', () => {
    expect(
      buildAgentWorktreeRows(
        detectedResult([scratch], { authoritative: false, source: 'session-fallback' }),
        makeRepo()
      )
    ).toEqual([])
    expect(buildAgentWorktreeRows(undefined, makeRepo())).toEqual([])
  })
})

describe('other worktree rows', () => {
  it('lists hidden externals and the ones an explicit import made visible, in detection order', () => {
    const imported = detectedWorktree({
      path: '/elsewhere/kept',
      displayName: 'kept',
      visible: true
    })
    const detected = detectedResult([imported, detectedWorktree(), scratch])

    expect(
      buildOtherWorktreeRows(
        detected,
        makeRepo({ importedExternalWorktreePaths: ['/elsewhere/kept'] })
      )
    ).toEqual([
      {
        id: imported.id,
        displayName: 'kept',
        path: '/elsewhere/kept',
        displayPath: '/elsewhere/kept',
        visible: true
      },
      {
        id: `repo-1::${EXTERNAL_PATH}`,
        displayName: 'manual',
        path: EXTERNAL_PATH,
        displayPath: EXTERNAL_PATH,
        visible: false
      }
    ])
  })

  it('lists nothing while the repo-wide setting shows this kind', () => {
    const detected = detectedResult([detectedWorktree({ visible: true })])

    expect(
      buildOtherWorktreeRows(
        detected,
        makeRepo({
          externalWorktreeVisibility: 'show',
          importedExternalWorktreePaths: [EXTERNAL_PATH]
        })
      )
    ).toEqual([])
  })

  it('leaves out rows the switch itself reveals, not an import', () => {
    // Why: a legacy repo shows unknown-legacy rows without any import, so they are
    // not exceptions and a row-level hide could not hide them.
    const detected = detectedResult([
      detectedWorktree({ ownership: 'unknown-legacy', visible: true })
    ])

    expect(
      buildOtherWorktreeRows(detected, makeRepo({ externalWorktreeVisibilityLegacy: true }))
    ).toEqual([])
  })

  it('spots an exception from the visibility rule, not from the recorded path list', () => {
    const detected = detectedResult([detectedWorktree({ visible: true })])

    // Why: the path list can lag behind reality; the row is an exception because the
    // rule without imports would hide it.
    expect(buildOtherWorktreeRows(detected, makeRepo())).toEqual([
      {
        id: `repo-1::${EXTERNAL_PATH}`,
        displayName: 'manual',
        path: EXTERNAL_PATH,
        displayPath: EXTERNAL_PATH,
        visible: true
      }
    ])
  })

  it('never mixes agent scratch into this kind', () => {
    const detected = detectedResult([
      scratch,
      { ...scratch, path: `${SCRATCH_PATH}-b`, visible: true }
    ])

    expect(
      buildOtherWorktreeRows(
        detected,
        makeRepo({ importedExternalWorktreePaths: [`${SCRATCH_PATH}-b`] })
      )
    ).toEqual([])
  })

  it('lists nothing while the detected snapshot is not authoritative', () => {
    expect(
      buildOtherWorktreeRows(
        detectedResult([detectedWorktree()], {
          authoritative: false,
          source: 'metadata-fallback'
        }),
        makeRepo()
      )
    ).toEqual([])
    expect(buildOtherWorktreeRows(undefined, makeRepo())).toEqual([])
  })
})

describe('non-Orca worktree visibility summary', () => {
  it('splits paths by current visibility so a bulk switch acts on the right half', () => {
    const rows = [
      { id: 'a', displayName: 'a', path: '/a', displayPath: 'a', visible: true },
      { id: 'b', displayName: 'b', path: '/b', displayPath: 'b', visible: false }
    ]

    expect(summarizeNonOrcaWorktreeRows(rows)).toEqual({
      total: 2,
      shownCount: 1,
      allShown: false,
      shownPaths: ['/a'],
      hiddenPaths: ['/b']
    })
  })

  it('reports an empty list as not fully shown so the bulk switch stays inert', () => {
    expect(summarizeNonOrcaWorktreeRows([])).toEqual({
      total: 0,
      shownCount: 0,
      allShown: false,
      shownPaths: [],
      hiddenPaths: []
    })
  })
})

describe('agent scratch policy selectors', () => {
  it('drops the per-worktree list once the scratch policy shows everything', () => {
    const detected = detectedResult([{ ...scratch, visible: true }])

    expect(buildAgentWorktreeRows(detected, makeRepo({ agentWorktreeVisibility: 'show' }))).toEqual(
      []
    )
  })

  it('still summarizes every scratch worktree while the list is dropped', () => {
    const detected = detectedResult([
      { ...scratch, visible: true },
      { ...scratch, id: 'repo-1::b', path: `${SCRATCH_PATH}-b`, visible: true }
    ])

    expect(
      summarizeAgentWorktreeVisibility(detected, makeRepo({ agentWorktreeVisibility: 'show' }))
    ).toMatchObject({ total: 2, shownCount: 2, allShown: true })
  })

  it('keeps the other kind intact when hiding a whole kind', () => {
    const repo = makeRepo({
      importedExternalWorktreePaths: [SCRATCH_PATH, '/elsewhere/manual', '/repo/.gsd-workspaces/g']
    })
    const detected = detectedResult([
      { ...scratch, visible: true },
      detectedWorktree({ path: '/elsewhere/manual', visible: true }),
      { ...scratch, id: 'repo-1::g', path: '/repo/.gsd-workspaces/g', visible: true }
    ])

    expect(importedPathsAfterHidingKind(repo, 'agent-scratch', detected)).toEqual([
      '/elsewhere/manual'
    ])
    expect(importedPathsAfterHidingKind(repo, 'other', detected)).toEqual([
      SCRATCH_PATH,
      '/repo/.gsd-workspaces/g'
    ])
  })

  it('files scratch created inside another checkout by its detected ownership', () => {
    // Why: main anchors the scratch matcher at every live checkout, so a path outside
    // repo.path can still be agent scratch and the purge must agree with that call.
    const nested = '/orca/workspaces/repo/branch/.claude/worktrees/nested'
    const repo = makeRepo({ importedExternalWorktreePaths: [nested] })
    const detected = detectedResult([
      detectedWorktree({
        path: nested,
        displayName: 'nested',
        ownership: 'agent-scratch',
        visible: true
      })
    ])

    expect(importedPathsAfterHidingKind(repo, 'agent-scratch', detected)).toEqual([])
    expect(importedPathsAfterHidingKind(repo, 'other', detected)).toEqual([nested])
  })

  it('falls back to the path rule for an import whose worktree left the disk', () => {
    const repo = makeRepo({ importedExternalWorktreePaths: [SCRATCH_PATH, '/elsewhere/gone'] })

    expect(importedPathsAfterHidingKind(repo, 'agent-scratch', detectedResult([]))).toEqual([
      '/elsewhere/gone'
    ])
  })

  it('lists the paths a kind hides so they can enter the decision ledger', () => {
    const detected = detectedResult([
      scratch,
      { ...scratch, id: 'repo-1::shown', path: `${SCRATCH_PATH}-shown`, visible: true },
      detectedWorktree(),
      detectedWorktree({ path: '/orca/managed', ownership: 'orca-managed' })
    ])

    // Why: the flip purges exceptions, so the visible one is going hidden too.
    expect(hiddenPathsForKind(detected, 'agent-scratch', makeRepo())).toEqual([
      SCRATCH_PATH,
      `${SCRATCH_PATH}-shown`
    ])
    expect(hiddenPathsForKind(detected, 'other', makeRepo())).toEqual([EXTERNAL_PATH])
  })

  it('records nothing for either kind when the snapshot is not authoritative', () => {
    const detected = detectedResult([scratch, detectedWorktree()], { authoritative: false })

    expect(hiddenPathsForKind(detected, 'agent-scratch', makeRepo())).toEqual([])
    expect(hiddenPathsForKind(detected, 'other', makeRepo())).toEqual([])
  })

  it('leaves out legacy rows the other switch cannot hide', () => {
    // Why: shouldShowWorktree keeps unknown-legacy visible on a legacy repo whatever the
    // setting, so counting it would promise a hide the button cannot deliver.
    const legacyRepo = makeRepo({
      addedAt: Date.UTC(2026, 0, 1),
      externalWorktreeVisibility: 'hide'
    })
    const detected = detectedResult([
      detectedWorktree({ path: '/orca/legacy', ownership: 'unknown-legacy', visible: true }),
      detectedWorktree()
    ])

    expect(summarizeOtherWorktreeVisibility(detected, legacyRepo)).toMatchObject({
      total: 1,
      shownCount: 0
    })
    expect(hiddenPathsForKind(detected, 'other', legacyRepo)).toEqual([EXTERNAL_PATH])
    // Why: the same repo added after the rollout has a real lever, so it stays counted.
    expect(summarizeOtherWorktreeVisibility(detected, makeRepo())).toMatchObject({
      total: 2,
      shownCount: 1
    })
  })
})
