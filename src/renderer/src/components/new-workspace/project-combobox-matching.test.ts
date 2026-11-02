import { describe, expect, it } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { rankProjectOptions } from './project-combobox-matching'

function project(id: string, displayName: string, detail: string): NewWorkspaceProjectOption {
  return { kind: 'project', id, projectId: id, displayName, badgeColor: '#111', detail }
}
const gateway = project('gateway', 'api-gateway', 'acme/api-gateway')

describe('rankProjectOptions', () => {
  it('matches the detail line when the name does not match', () => {
    const ranked = rankProjectOptions([gateway], 'acme', [])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.detailHits.length).toBeGreaterThan(0)
  })

  it('matches a scattered subsequence in the name but not in the detail', () => {
    const hosts = project('infra', 'infra', '3 hosts configured')
    // Detail search is substring-only; scattered sc in hosts configured must not match.
    expect(rankProjectOptions([hosts], 'sc', [])).toHaveLength(0)
    expect(rankProjectOptions([hosts], 'ifa', [])).toHaveLength(1)
  })
})
