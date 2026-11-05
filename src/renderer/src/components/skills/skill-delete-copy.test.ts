import { expect, it, vi } from 'vitest'
import type { SkillDeletePlan } from '../../../../shared/skill-delete-contract'
import { skillDeletePlacementSummary } from './skill-delete-copy'

function plan(skills: SkillDeletePlan['skills']): SkillDeletePlan {
  return { operationId: 'op', skills }
}

it('sorts deletion roots once with unchanged case, accent, and number ordering', () => {
  const labels = ['éclair', 'Eclair', 'item2', 'item10', 'Ångström', 'zebra', 'İstanbul']
  const expected = [...labels].sort((a, b) =>
    // ast-grep-ignore: no-repeated-collator -- Preserve the old comparator as the parity oracle.
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )
  const NativeCollator = Intl.Collator
  const construct = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
    return new NativeCollator(locales, options)
  })
  const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
  try {
    const summary = skillDeletePlacementSummary(
      plan([
        {
          id: 'a',
          name: 'demo',
          canonicalPath: '/root/demo/SKILL.md',
          placements: labels.map((rootLabel) => ({
            path: '/root/demo',
            kind: 'canonical',
            rootLabel
          }))
        }
      ])
    )
    expect(summary).toContain(expected.join(', '))
    // The process-wide renderer collator must be constructed at most once, never per comparison.
    expect(construct.mock.calls.length).toBeLessThanOrEqual(1)
    for (const call of construct.mock.calls) {
      expect(call).toEqual([undefined, { sensitivity: 'base' }])
    }
    expect(localeCompare).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})
