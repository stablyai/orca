import { describe, expect, it } from 'vitest'
import type { SkillDeletePlan } from '../../../../shared/skill-delete-contract'
import {
  skillDeleteBlockedLines,
  skillDeletePlacementSummary,
  skillDeleteResultLines,
  skillDeleteRetainedSourceLines
} from './skill-delete-copy'

function plan(skills: SkillDeletePlan['skills']): SkillDeletePlan {
  return { operationId: 'op', skills }
}

describe('skillDeletePlacementSummary', () => {
  it('summarizes folders, links, and the roots they sit in', () => {
    const summary = skillDeletePlacementSummary(
      plan([
        {
          id: 'a',
          name: 'demo',
          canonicalPath: '/root/demo/SKILL.md',
          placements: [
            {
              path: '/home/.agents/skills/demo',
              kind: 'canonical',
              rootLabel: 'Agent skills home'
            },
            { path: '/home/.claude/skills/demo', kind: 'alias-dir', rootLabel: 'Claude home' }
          ]
        }
      ])
    )
    expect(summary).toContain('1')
    expect(summary).toContain('Agent skills home')
    expect(summary).toContain('Claude home')
  })

  it('drops the zero half so a link-only delete never reads "0 folders"', () => {
    const summary = skillDeletePlacementSummary(
      plan([
        {
          id: 'a',
          name: 'demo',
          canonicalPath: '/home/.local/share/devex/skills/demo/SKILL.md',
          placements: [
            { path: '/repo/.agents/skills/demo', kind: 'alias-dir', rootLabel: 'Repo app .agents' }
          ]
        }
      ])
    )
    expect(summary).not.toContain('0')
    expect(summary).toContain('link')
    expect(summary).not.toContain('folder')
  })

  it('is null when the plan removes nothing', () => {
    // Otherwise the dialog read "0 folders and 0 links across " with an empty
    // tail, beside a red button that could not do anything.
    expect(
      skillDeletePlacementSummary(
        plan([
          {
            id: 'a',
            name: 'demo',
            canonicalPath: '/elsewhere/demo/SKILL.md',
            placements: [],
            blocked: 'unowned'
          }
        ])
      )
    ).toBeNull()
  })
})

describe('skillDeleteRetainedSourceLines', () => {
  it('says where the content stays when only links are removed', () => {
    const lines = skillDeleteRetainedSourceLines(
      plan([
        {
          id: 'a',
          name: 'demo',
          canonicalPath: '/home/.local/share/devex/skills/demo/SKILL.md',
          placements: [
            { path: '/repo/.agents/skills/demo', kind: 'alias-dir', rootLabel: 'Repo app .agents' }
          ]
        }
      ])
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/home/.local/share/devex/skills/demo')
  })

  it('stays silent when a real folder is being removed', () => {
    expect(
      skillDeleteRetainedSourceLines(
        plan([
          {
            id: 'a',
            name: 'demo',
            canonicalPath: '/home/.agents/skills/demo/SKILL.md',
            placements: [
              {
                path: '/home/.agents/skills/demo',
                kind: 'canonical',
                rootLabel: 'Agent skills home'
              }
            ]
          }
        ])
      )
    ).toEqual([])
  })
})

describe('skillDeleteBlockedLines', () => {
  it('groups by typed reason rather than one merged skipped line', () => {
    const lines = skillDeleteBlockedLines(
      plan([
        { id: 'a', name: 'a', canonicalPath: '/p', placements: [], blocked: 'bundled' },
        { id: 'b', name: 'b', canonicalPath: '/p', placements: [], blocked: 'bundled' },
        { id: 'c', name: 'c', canonicalPath: '/p', placements: [], blocked: 'plugin' }
      ])
    )
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.includes('2') && line.includes('Bundled'))).toBe(true)
  })
})

describe('skillDeleteResultLines', () => {
  it('omits deleted rows and keeps one line per distinct outcome', () => {
    const lines = skillDeleteResultLines([
      { id: 'a', name: 'a', status: 'deleted', removedPaths: ['/x'] },
      { id: 'b', name: 'b', status: 'skipped', blocked: 'unowned', removedPaths: [] },
      { id: 'c', name: 'c', status: 'skipped', blocked: 'unowned', removedPaths: [] },
      { id: 'd', name: 'd', status: 'busy', removedPaths: [] }
    ])
    expect(lines.map((line) => line.key)).toEqual(['skipped:unowned', 'busy'])
    expect(lines[0].label).toContain('2')
  })

  it('renders nothing when every skill was deleted', () => {
    expect(
      skillDeleteResultLines([{ id: 'a', name: 'a', status: 'deleted', removedPaths: ['/x'] }])
    ).toEqual([])
  })
})
