/**
 * Issue #8739 — Linear filters only show options from the first selected team.
 *
 * Filter chrome loads status/assignee/label metadata for `primaryTeam` only
 * (resolveLinearIssueAttributeFilterPrimaryTeam → single team). Multi-team /
 * "All teams" selection never unions options across selected teams.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/repro-8739-linear-filter-first-team.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from './linear-issue-attribute-filter-primary-team'
import type { LinearTeam } from '../../../shared/types'

const teams: LinearTeam[] = [
  { id: 'team-be', name: 'Backend', key: 'BE' },
  { id: 'team-fe', name: 'Frontend', key: 'FE' },
  { id: 'team-ops', name: 'Ops', key: 'OPS' }
]

/** Mirrors LinearIssueAttributeFilterDropdowns: only primary team's option set is shown. */
function filterOptionsForSelection(
  selectedTeamIds: string[],
  optionsByTeamId: Record<string, string[]>
): { primaryTeamId: string | null; optionIds: string[] } {
  const primary = resolveLinearIssueAttributeFilterPrimaryTeam({
    selectedTeamIds,
    availableTeams: teams
  })
  if (!primary) {
    return { primaryTeamId: null, optionIds: [] }
  }
  return {
    primaryTeamId: primary.id,
    optionIds: optionsByTeamId[primary.id] ?? []
  }
}

describe('issue #8739 Linear multi-team filter options collapse to first team', () => {
  const optionsByTeamId = {
    'team-be': ['be-todo', 'be-done'],
    'team-fe': ['fe-todo', 'fe-review'],
    'team-ops': ['ops-blocked']
  }

  it('loads only the primary (first-by-name) selected team when two teams are selected', () => {
    // Selected Frontend + Backend; name order picks Backend first → FE options dropped.
    const result = filterOptionsForSelection(['team-fe', 'team-be'], optionsByTeamId)
    expect(result.primaryTeamId).toBe('team-be')
    expect(result.optionIds).toEqual(['be-todo', 'be-done'])
    expect(result.optionIds).not.toContain('fe-todo')
    expect(result.optionIds).not.toContain('fe-review')
  })

  it('still collapses when all teams are selected (All teams)', () => {
    const result = filterOptionsForSelection(['team-be', 'team-fe', 'team-ops'], optionsByTeamId)
    expect(result.primaryTeamId).toBe('team-be')
    expect(result.optionIds.sort()).toEqual(['be-done', 'be-todo'])
    // Ops/Frontend metadata never appear in the filter option list.
    expect(result.optionIds).not.toContain('fe-todo')
    expect(result.optionIds).not.toContain('fe-review')
    expect(result.optionIds).not.toContain('ops-blocked')
  })

  it('UI source only queries metadata for primaryTeam, not the selection set', () => {
    const src = readFileSync(join(__dirname, 'linear-issue-attribute-filter-dropdowns.tsx'), 'utf8')
    // Single active team id from primaryTeam only.
    expect(src).toMatch(
      /activeTeamId = popoverOpen && !isAllWorkspaces \? \(primaryTeam\?\.id \?\? null\) : null/
    )
    expect(src).toContain('useTeamStates(activeTeamId')
    expect(src).toContain('useTeamLabels(activeTeamId')
    expect(src).toContain('useTeamMembers(activeTeamId')
    // Banner admits multi-select still shows one team.
    expect(src).toMatch(/Options from \{\{team\}\}/)
    expect(src).toMatch(/selectedTeamCount > 1 && primaryTeam/)
    // No loop over selected teams for metadata load.
    expect(src).not.toMatch(/for\s*\(.*selectedTeam/)
    expect(src).not.toMatch(/selectedTeamIds\.map/)
  })
})
