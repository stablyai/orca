import { describe, expect, it } from 'vitest'
import {
  BUNDLED_SKILL_LEAVE_REASONS,
  BUNDLED_SKILL_OP_KINDS,
  type BundledSkillOp,
  type BundledSkillOpOutcome,
  type BundledSkillOpKind,
  type BundledSkillPlan
} from './bundled-skill-plan'
import {
  BUNDLED_SKILL_LEAVE_REASON_TEXT,
  bundledSkillInstallAction,
  bundledSkillInstallAgents,
  bundledSkillNudgeKey,
  bundledSkillPlanState,
  bundledSkillOutcomeText,
  summarizeBundledSkillOutcomes,
  summarizeBundledSkillPlan
} from './bundled-skill-summary'

function op(kind: BundledSkillOpKind, path = `/home/.agents/skills/${kind}`): BundledSkillOp {
  return { kind, path, role: 'shared', agents: [], observed: { kind: 'absent' }, cleanup: [] }
}

function plan(
  ops: BundledSkillOp[][],
  scope: BundledSkillPlan['scope'] = 'global'
): BundledSkillPlan {
  return {
    scope,
    homeDirectory: '/home/u',
    planDigest: 'digest',
    skills: ops.map((skillOps, index) => ({
      name: `s${index}`,
      digest: `d${index}`,
      ops: skillOps
    }))
  }
}

describe('summarizeBundledSkillPlan', () => {
  it('raises the badge only for global rewrites and repairs', () => {
    const expected: Record<BundledSkillOpKind, 'update' | 'repair' | null> = {
      keep: null,
      leave: null,
      write: null,
      link: null,
      copy: null,
      update: 'update',
      replace: 'update',
      restore: 'repair'
    }
    for (const kind of BUNDLED_SKILL_OP_KINDS) {
      expect([kind, summarizeBundledSkillPlan(plan([[op(kind)]])).badge]).toEqual([
        kind,
        expected[kind]
      ])
      expect(summarizeBundledSkillPlan(plan([[op(kind)]], 'workspace')).badge).toBeNull()
    }
    expect(summarizeBundledSkillPlan(plan([[op('update')], [op('restore')]])).badge).toBe('repair')
  })

  it('reads an op kind from a newer host as needing attention', () => {
    const unknown = { ...op('keep'), kind: 'teleport' }
    // @ts-expect-error -- a newer server can send a kind this build does not know.
    const summary = summarizeBundledSkillPlan(plan([[unknown]]))
    expect(summary.skills[0].state).toBe('attention')
    expect(summary.hasWork).toBe(false)
  })

  it('counts leftover swap siblings as work without raising the badge', () => {
    const withCleanup: BundledSkillOp = {
      ...op('keep'),
      cleanup: [{ path: '/x/.s.orca-old-1', action: 'delete', observed: { kind: 'absent' } }]
    }
    expect(summarizeBundledSkillPlan(plan([[withCleanup]]))).toMatchObject({
      badge: null,
      hasWork: true
    })
    expect(summarizeBundledSkillPlan(plan([[op('keep')]])).hasWork).toBe(false)
  })

  it("treats someone else's same-named skill as theirs, not as attention", () => {
    const other: BundledSkillOp = { ...op('leave'), reason: 'other', replaceable: true }
    const edited: BundledSkillOp = { ...op('leave'), reason: 'edited', replaceable: true }
    expect(bundledSkillPlanState(plan([[op('keep'), other]]).skills[0])).toBe('current')
    expect(bundledSkillPlanState(plan([[op('keep'), edited]]).skills[0])).toBe('attention')
    expect(bundledSkillPlanState(plan([[op('update'), other]]).skills[0])).toBe('update')
  })

  it('has wording for every leave reason', () => {
    for (const reason of BUNDLED_SKILL_LEAVE_REASONS) {
      expect(BUNDLED_SKILL_LEAVE_REASON_TEXT[reason]).toMatch(/\S/u)
    }
  })
})

describe('summarizeBundledSkillOutcomes', () => {
  const done = (kind: BundledSkillOpKind) => ({ path: `/${kind}`, kind, status: 'done' as const })

  it('never calls a change, a skip or a failure success', () => {
    const text = (ops: Parameters<typeof bundledSkillOutcomeText>[0]['ops']) =>
      bundledSkillOutcomeText({ name: 's', status: 'ran', ops })
    expect(text([done('keep')])).toBe('No change')
    expect(text([done('keep'), done('link')])).toBe('Linked')
    expect(text([done('write'), done('link')])).toBe('Installed')
    expect(text([done('update'), done('link')])).toBe('Updated')
    expect(text([done('update'), done('leave')])).toBe('Updated')
    expect(text([done('leave')])).toBe('No change')
    expect(text([done('restore')])).toBe('Needs attention')
    for (const status of ['changed', 'skipped', 'failed'] as const) {
      expect(text([done('update'), { ...done('link'), status }])).toBe('Needs attention')
    }
    for (const status of ['changed', 'busy'] as const) {
      expect(bundledSkillOutcomeText({ name: 's', status, ops: [] })).toBe('Needs attention')
    }
  })

  it('reports leaves as warnings and exits 1 only for a failed or changed op', () => {
    const ran = (ops: BundledSkillOpOutcome[]) => ({ name: 's', status: 'ran' as const, ops })
    const left = { ...done('leave'), reason: 'edited' as const }
    const summary = summarizeBundledSkillOutcomes({
      scope: 'global',
      skills: [ran([done('update'), left]), ran([left])]
    })
    expect(summary).toMatchObject({ ok: true, exitCode: 0 })
    expect(summary.skills.map((skill) => skill.line)).toEqual([
      'Updated · 1 skipped: Skill edited outside Orca',
      'No change · 1 skipped: Skill edited outside Orca'
    ])
    expect(summary.skills[0].leftAlone).toEqual([
      { path: '/leave', reason: 'Skill edited outside Orca', code: 'edited' }
    ])
    for (const status of ['changed', 'failed'] as const) {
      expect(
        summarizeBundledSkillOutcomes({
          scope: 'global',
          skills: [ran([{ ...done('update'), status }])]
        })
      ).toMatchObject({ ok: false, exitCode: 1 })
    }
    expect(
      summarizeBundledSkillOutcomes({
        scope: 'global',
        skills: [{ name: 's', status: 'changed', ops: [] }]
      }).exitCode
    ).toBe(1)
  })
  it('counts skipped skills once while retaining every skipped folder and reason', () => {
    const summary = summarizeBundledSkillOutcomes({
      scope: 'global',
      skills: [
        {
          name: 'orca-cli',
          status: 'ran',
          ops: [
            { path: '/shared/orca-cli', kind: 'update', status: 'done' },
            { path: '/claude/orca-cli', kind: 'update', status: 'done' }
          ]
        },
        {
          name: 'orchestration',
          status: 'ran',
          ops: [{ path: '/shared/orchestration', kind: 'update', status: 'done' }]
        },
        {
          name: 'computer-use',
          status: 'ran',
          ops: [
            { path: '/shared', kind: 'leave', status: 'done', reason: 'edited' },
            { path: '/claude', kind: 'leave', status: 'done', reason: 'shared-not-current' },
            { path: '/cursor', kind: 'leave', status: 'done', reason: 'shared-not-current' }
          ]
        }
      ]
    })

    expect(summary).toMatchObject({ ok: true, changedCount: 2, leftAloneCount: 1 })
    expect(summary.skills[2].leftAlone.map((left) => left.path)).toEqual([
      '/shared',
      '/claude',
      '/cursor'
    ])
    expect(summary.skills[2].line).toBe(
      "No change · 1 skipped: Skill edited outside Orca; The shared copy isn't Orca's"
    )
  })
})

describe('bundledSkillInstallAgents', () => {
  it('lists the agents newly given the skill, once each and sorted', () => {
    const forAgents = (
      kind: BundledSkillOpKind,
      agents: BundledSkillOp['agents']
    ): BundledSkillOp => ({ ...op(kind, `/${kind}/${agents.join(',')}`), agents })
    const entries = plan([
      [forAgents('write', ['codex']), forAgents('link', ['claude'])],
      [forAgents('copy', ['cursor', 'claude']), forAgents('update', ['gemini'])],
      [forAgents('keep', ['droid']), forAgents('leave', ['grok'])]
    ]).skills
    expect(bundledSkillInstallAgents(entries)).toEqual(['claude', 'codex', 'cursor'])
    expect(bundledSkillInstallAgents([])).toEqual([])
  })
})

describe('bundledSkillNudgeKey', () => {
  it('names the host and the digests the badge counts', () => {
    expect(bundledSkillNudgeKey('local', plan([[op('update')], [op('link')]]))).toBe(
      'bundled-skill:v1:local:s0@d0'
    )
    expect(bundledSkillNudgeKey('local', plan([[op('link')]]))).toBeNull()
    expect(bundledSkillNudgeKey('local', plan([[op('update')]], 'workspace'))).toBeNull()
  })
})

describe('bundledSkillInstallAction', () => {
  it('runs work, offers Replace only for replaceable copies, else nothing', () => {
    expect(bundledSkillInstallAction(plan([[op('keep'), op('link')]]))).toEqual({ kind: 'run' })
    const edited = { ...op('leave', '/a'), reason: 'edited' as const, replaceable: true }
    const unwritable = { ...op('leave', '/b'), reason: 'unwritable' as const }
    expect(bundledSkillInstallAction(plan([[op('keep'), edited, unwritable]]))).toEqual({
      kind: 'replace',
      paths: ['/a']
    })
    expect(bundledSkillInstallAction(plan([[op('keep'), unwritable]]))).toEqual({
      kind: 'attention'
    })
  })

  it.each(['unwritable', 'busy'] as const)('needs attention when absent work is %s', (reason) => {
    expect(bundledSkillInstallAction(plan([[{ ...op('leave'), reason }]]))).toEqual({
      kind: 'attention'
    })
    expect(bundledSkillInstallAction(plan([[op('keep')]]))).toEqual({ kind: 'none' })
    expect(bundledSkillInstallAction(plan([[]]))).toEqual({ kind: 'attention' })
  })
})
