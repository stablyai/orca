import { describe, expect, it } from 'vitest'
import {
  officeSkillInstallPairs,
  summarizeOfficeSkillInstall,
  toggleInSet
} from './office-skills-catalog-state'

describe('office skill selection', () => {
  it('installs every chosen skill on every chosen agent', () => {
    const pairs = officeSkillInstallPairs({
      skills: new Set(['pptx', 'word']),
      agents: new Set(['claude', 'codex'])
    })
    expect(pairs).toHaveLength(4)
    expect(pairs).toContainEqual({ skill: 'word', agent: 'codex' })
  })

  it('asks for nothing when either side is unchosen', () => {
    expect(officeSkillInstallPairs({ skills: new Set(['pptx']), agents: new Set() })).toEqual([])
    expect(officeSkillInstallPairs({ skills: new Set(), agents: new Set(['claude']) })).toEqual([])
  })

  it('counts per pair, so one refusal is not the whole action failing', () => {
    expect(
      summarizeOfficeSkillInstall([
        { skill: 'pptx', agent: 'claude', installed: true, detail: null },
        { skill: 'pptx', agent: 'codex', installed: false, detail: 'no codex config' }
      ])
    ).toEqual({ installed: 1, failed: 1 })
  })

  it('toggles a value in and out without mutating the source set', () => {
    const first = new Set(['pptx'])
    const second = toggleInSet(first, 'word')
    expect([...first]).toEqual(['pptx'])
    expect(second.has('word')).toBe(true)
    expect(toggleInSet(second, 'word').has('word')).toBe(false)
  })
})
