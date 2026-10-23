import { describe, expect, it } from 'vitest'
import type { BundledSkillOp } from './bundled-skill-plan'
import { bundledSkillLocation, collapseHomePath } from './bundled-skill-locations'

function op(extra: Partial<BundledSkillOp>): BundledSkillOp {
  return {
    kind: 'keep',
    path: '/home/u/.agents/skills/orca-cli',
    role: 'shared',
    agents: ['codex'],
    observed: { kind: 'absent' },
    cleanup: [],
    ...extra
  }
}

describe('collapseHomePath', () => {
  it('shows the home as ~ on POSIX and Windows, and only at a separator', () => {
    expect(collapseHomePath('/home/u/.claude/skills/x', '/home/u')).toBe('~/.claude/skills/x')
    expect(collapseHomePath('/home/user/x', '/home/u')).toBe('/home/user/x')
    expect(collapseHomePath('C:\\Users\\Maya\\.claude\\skills\\x', 'c:\\users\\maya')).toBe(
      '~\\.claude\\skills\\x'
    )
    expect(collapseHomePath('/srv/x', '/home/u')).toBe('/srv/x')
  })
})

describe('bundledSkillLocation', () => {
  it('names the shared folder and agent folders, and tells a kept link from a kept copy', () => {
    expect(bundledSkillLocation(op({ kind: 'update' }), '/home/u')).toMatchObject({
      displayPath: '~/.agents/skills/orca-cli',
      place: { kind: 'shared' },
      state: 'update'
    })
    expect(
      bundledSkillLocation(
        op({
          role: 'agent',
          agents: ['claude'],
          path: '/home/u/.claude/skills/orca-cli',
          observed: { kind: 'link', target: '../../.agents/skills/orca-cli' }
        }),
        '/home/u'
      )
    ).toMatchObject({ place: { kind: 'agents', names: ['Claude Code'] }, state: 'keep-link' })
    expect(
      bundledSkillLocation(
        op({
          role: 'agent',
          agents: ['claude'],
          kind: 'leave',
          reason: 'edited',
          replaceable: true
        }),
        '/home/u'
      )
    ).toMatchObject({ state: 'leave', reason: 'edited', replaceable: true })
  })
})
