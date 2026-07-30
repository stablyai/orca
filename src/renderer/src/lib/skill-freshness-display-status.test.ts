import { describe, expect, it } from 'vitest'
import type {
  SkillFreshnessInstallation,
  SkillFreshnessInventory,
  SkillFreshnessScanIssueReason,
  SkillFreshnessStatus
} from '../../../shared/skill-freshness'
import {
  getSkillFreshnessDisplayStatus,
  hasSkillCopyNeedingAttention
} from './skill-freshness-display-status'

const SKILL_NAME = 'orca-cli'

function scanIssue(
  reason: SkillFreshnessScanIssueReason
): SkillFreshnessInventory['scanIssues'][number] {
  return {
    rootId: 'codex-plugin-cache',
    sourceLabel: 'Codex plugin cache',
    path: '/home/.codex/plugins/cache',
    reason,
    errorCode: reason === 'io-error' ? 'EACCES' : null
  }
}

function placement(status: SkillFreshnessStatus, index = 0): SkillFreshnessInstallation {
  return {
    id: `${SKILL_NAME}-${index}`,
    name: SKILL_NAME,
    rootId: 'home-agents',
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    unresolvedPath: `/home/.agents/skills/${SKILL_NAME}-${index}`,
    resolvedPath: `/home/.agents/skills/${SKILL_NAME}-${index}`,
    physicalIdentity: `physical-${index}`,
    topology: 'canonical-copy',
    status,
    installedReleaseRevision: 1,
    installedAppVersion: '1.0.0',
    currentReleaseRevision: 2,
    currentPackageDigest: 'current',
    currentAppVersion: '2.0.0',
    observedPackageDigest: status === 'current' ? 'current' : 'other',
    errorCategory: null
  }
}

function pluginCachePlacement(
  status: SkillFreshnessStatus = 'unrecognized'
): SkillFreshnessInstallation {
  return {
    ...placement(status, 9),
    topology: 'plugin-cache',
    unresolvedPath: `/home/.codex/plugins/cache/openai-bundled/${SKILL_NAME}`
  }
}

function repoPlacement(status: SkillFreshnessStatus = 'unrecognized'): SkillFreshnessInstallation {
  return {
    ...placement(status, 7),
    rootId: 'repo-work',
    sourceKind: 'repo',
    sourceLabel: 'work',
    topology: 'repo-scope',
    unresolvedPath: `/home/projects/work/.agents/skills/${SKILL_NAME}`,
    resolvedPath: `/home/projects/work/.agents/skills/${SKILL_NAME}`
  }
}

function inventory(
  installations: SkillFreshnessInstallation[],
  eligibleUpdateNames: string[] = [],
  scanIssues: SkillFreshnessInventory['scanIssues'] = []
): SkillFreshnessInventory {
  return { schemaVersion: 1, installations, eligibleUpdateNames, scanIssues, scannedAt: 1 }
}

describe('getSkillFreshnessDisplayStatus', () => {
  it('shows update available when the inventory authorizes an update', () => {
    expect(
      getSkillFreshnessDisplayStatus(inventory([placement('outdated')], [SKILL_NAME]), SKILL_NAME)
    ).toBe('update-available')
  })

  it('shows up to date only when every discovered placement is current', () => {
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('current'), placement('current', 1)]),
        SKILL_NAME
      )
    ).toBe('up-to-date')
  })

  it.each([
    ['before the inventory loads', null],
    ['when the inventory has no matching placement', inventory([])]
  ])('reports presence only %s', (_scenario, value) => {
    // Why: with nothing scanned there is no drift to claim, and flashing attention
    // on every launch before the first scan would train the user to ignore it.
    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('installed')
  })

  it.each([
    [
      'when any placement is unrecognized',
      inventory([placement('current'), placement('unrecognized', 1)])
    ],
    ['when a placement is inaccessible', inventory([placement('inaccessible')])],
    ['when an outdated placement is not eligible', inventory([placement('outdated')])]
  ])('reports needs attention %s', (_scenario, value) => {
    // Why: no eligible update is not proof a copy is fine. Green here would read as
    // all-clear over drift the update command cannot reach and the user cannot see.
    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('needs-attention')
  })

  it.each([
    ['depth-limit'],
    ['entry-limit'],
    ['candidate-limit'],
    ['manifest-limit'],
    ['issue-limit'],
    // Why: a vendor linking its skills out of the cache is a packaging choice, not a
    // fault the user can clear — deleting the link only makes the package manager
    // recreate it. Amber here is clean-on-main turned permanently amber.
    ['outside-root']
  ] as const)('does not report attention for the %s traversal bound', (reason) => {
    // Why: these are Orca's own bounds. A large but healthy plugin cache would
    // otherwise pin every skill amber with nothing the user could do about it.
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('current')], [], [scanIssue(reason)]),
        SKILL_NAME
      )
    ).toBe('up-to-date')
  })

  // Why: the only reason left that is a fact about the user's own disk rather than a
  // bound Orca chose, so the only one a person can actually clear.
  it('reports needs attention for the io-error scan fault', () => {
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('current')], [], [scanIssue('io-error')]),
        SKILL_NAME
      )
    ).toBe('needs-attention')
  })

  it('stays up to date beside another ecosystem’s same-name skill', () => {
    // Why: the copy belongs to another tool, so no user action exists to clear it.
    // Amber here is the badge-with-no-exit reported in #10633.
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('current'), pluginCachePlacement()]),
        SKILL_NAME
      )
    ).toBe('up-to-date')
    expect(hasSkillCopyNeedingAttention(inventory([pluginCachePlacement()]), SKILL_NAME)).toBe(
      false
    )
  })

  it('shows recognized-newer content as up to date instead of blaming the user', () => {
    // Why: 'newer-known' is official content ahead of this build — the updater's own
    // install or a newer release's bytes. Amber here sent users on a remove/reinstall
    // loop that lands the same newer content (#11220's scan half).
    const value = inventory([placement('newer-known')])

    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('up-to-date')
    expect(hasSkillCopyNeedingAttention(value, SKILL_NAME)).toBe(false)
  })

  it('still reports drift beside a newer-known copy', () => {
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('newer-known'), placement('unrecognized', 1)]),
        SKILL_NAME
      )
    ).toBe('needs-attention')
  })

  it('still reports drift in our own copy when a plugin-managed one sits alongside', () => {
    expect(
      getSkillFreshnessDisplayStatus(
        inventory([placement('unrecognized'), pluginCachePlacement()]),
        SKILL_NAME
      )
    ).toBe('needs-attention')
  })

  it('reports attention when a plugin-cache copy is inaccessible', () => {
    const value = inventory([pluginCachePlacement('inaccessible')])

    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('needs-attention')
    expect(hasSkillCopyNeedingAttention(value, SKILL_NAME)).toBe(true)
  })
})

describe('hasSkillCopyNeedingAttention', () => {
  it('raises no attention marker over a routine outdated copy the update converges', () => {
    // Why: an out-of-date convergent copy is ordinary work for the update command.
    // Amber on the review affordance there would cry wolf on every routine update.
    expect(
      hasSkillCopyNeedingAttention(inventory([placement('outdated')], [SKILL_NAME]), SKILL_NAME)
    ).toBe(false)
  })

  it('ignores a traversal bound but keeps a real scan fault', () => {
    expect(
      hasSkillCopyNeedingAttention(
        inventory([placement('current')], [], [scanIssue('entry-limit')]),
        SKILL_NAME
      )
    ).toBe(false)
    expect(
      hasSkillCopyNeedingAttention(
        inventory([placement('current')], [], [scanIssue('io-error')]),
        SKILL_NAME
      )
    ).toBe(true)
  })

  // The exact shape of the rc.4 report: a pristine global install alongside a drifted
  // copy inside a work directory. Orca only updates global skills, so the project copy
  // must not turn the badge amber over drift it has no way to fix.
  it('reports up to date for a current global copy beside a drifted project copy', () => {
    const value = inventory([placement('current'), repoPlacement('unrecognized')])

    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('up-to-date')
    expect(hasSkillCopyNeedingAttention(value, SKILL_NAME)).toBe(false)
  })

  // Why by scope and not by status: an outdated or unreadable project copy is just as
  // far outside the global updater's reach as an unrecognized one, so pinning only the
  // reported status would leave the same bug reachable through a different one.
  it.each<[SkillFreshnessStatus]>([['unrecognized'], ['outdated'], ['inaccessible']])(
    'ignores a %s project copy when judging global freshness',
    (status) => {
      const value = inventory([placement('current'), repoPlacement(status)])

      expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('up-to-date')
    }
  )

  // A project copy is not evidence the skill is installed globally, so it reports
  // presence rather than a freshness claim about a copy Orca does not manage.
  it('reports presence only when every copy is project-owned', () => {
    expect(getSkillFreshnessDisplayStatus(inventory([repoPlacement()]), SKILL_NAME)).toBe(
      'installed'
    )
  })

  // Regression guard for the centralization: the badge predicate deliberately omits the
  // shared helper's outdated carve-out, so a non-eligible outdated copy stays amber.
  // Collapsing the two predicates would flip this to green while the dialog still shows
  // a reinstall row — the badge/dialog contradiction this change exists to avoid.
  it('keeps a non-eligible outdated global copy amber', () => {
    expect(getSkillFreshnessDisplayStatus(inventory([placement('outdated')]), SKILL_NAME)).toBe(
      'needs-attention'
    )
  })

  // Why: an unreadable plugin path could hide a copy of anything, but a skill Orca
  // never found anywhere is not the one to blame for it — that reads as a problem
  // with a skill the user has not installed.
  it('does not blame a skill with no placement for a fault elsewhere in the cache', () => {
    const value = inventory([], [], [scanIssue('io-error')])

    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('installed')
    expect(hasSkillCopyNeedingAttention(value, SKILL_NAME)).toBe(false)
  })

  // Why: a project copy is not the presence that makes the cache fault this skill's
  // problem either. The two helpers have to read the same placements, or the badge calls
  // a repo-only skill merely installed while the review affordance flags it amber.
  it('does not treat a project copy as the presence that owns a cache fault', () => {
    const value = inventory([repoPlacement()], [], [scanIssue('io-error')])

    expect(getSkillFreshnessDisplayStatus(value, SKILL_NAME)).toBe('installed')
    expect(hasSkillCopyNeedingAttention(value, SKILL_NAME)).toBe(false)
  })
})
