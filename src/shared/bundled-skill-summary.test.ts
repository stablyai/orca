import { describe, expect, it } from 'vitest'
import type { BundledSkillOp, BundledSkillPlan } from './bundled-skill-plan'
import { bundledSkillNudgeKey, summarizeBundledSkillPlan } from './bundled-skill-summary'

const folder = { kind: 'folder', entries: ['SKILL.md:file'], skillDigest: 'a'.repeat(64) } as const

function op(fields: Partial<BundledSkillOp>): BundledSkillOp {
  return {
    kind: 'keep',
    path: '/home/me/.agents/skills/x',
    role: 'shared',
    agents: [],
    observed: folder,
    cleanup: [],
    ...fields
  }
}

/** A plan as a paired server returns it: planned on the server's disk against the server's own bundle. */
const serverPlan = (ops: BundledSkillOp[]): BundledSkillPlan => ({
  scope: 'global',
  homeDirectory: '/home/me',
  skills: [{ name: 'orca-cli', digest: 'b'.repeat(64), ops }],
  planDigest: 'c'.repeat(64)
})

describe('another Orca build’s copy in a planned host’s plan', () => {
  it('reads as current and is never offered as an update', () => {
    const plan = serverPlan([
      op({ kind: 'leave', reason: 'other-build', replaceable: true }),
      op({
        path: '/home/me/.claude/skills/x',
        role: 'agent',
        observed: { kind: 'link', target: 'x' }
      })
    ])

    expect(summarizeBundledSkillPlan(plan)).toMatchObject({
      badge: null,
      hasWork: false,
      skills: [{ name: 'orca-cli', state: 'current' }]
    })
    expect(bundledSkillNudgeKey('runtime:server-1', plan)).toBeNull()
  })
})
