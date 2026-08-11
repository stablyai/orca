import { describe, expect, it } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import {
  getAmbiguousProjectOptionIds,
  rankProjectOptions,
  sectionProjectOptions,
  splitDetailForElision
} from './project-combobox-matching'

function project(id: string, displayName: string, detail: string): NewWorkspaceProjectOption {
  return { kind: 'project', id, projectId: id, displayName, badgeColor: '#111', detail }
}

const orca = project('orca', 'orca', 'stablyai/orca')
const relay = project('relay', 'orca-relay', 'stablyai/orca-relay')
const gateway = project('gateway', 'api-gateway', 'acme/api-gateway')

describe('rankProjectOptions', () => {
  it('ranks a name-prefix match above a mid-name match', () => {
    const ranked = rankProjectOptions([relay, orca], 'orca', [])
    expect(ranked[0]?.option.id).toBe('orca')
  })

  it('matches the detail line when the name does not match', () => {
    const ranked = rankProjectOptions([gateway], 'acme', [])
    expect(ranked).toHaveLength(1)
    expect(ranked[0]?.detailHits.length).toBeGreaterThan(0)
  })

  it('matches a scattered subsequence in the name but not in the detail', () => {
    const hosts = project('infra', 'infra', '3 hosts configured')
    // "sc" appears scattered in "hosts configured" but detail matching is
    // substring-only, so this must not match on the detail line.
    expect(rankProjectOptions([hosts], 'sc', [])).toHaveLength(0)
    expect(rankProjectOptions([hosts], 'ifa', [])).toHaveLength(1)
  })

  it('orders an unfiltered list by recency', () => {
    const ranked = rankProjectOptions([orca, relay, gateway], '', ['gateway', 'relay'])
    expect(ranked.map((r) => r.option.id)).toEqual(['gateway', 'relay', 'orca'])
  })

  it('returns nothing for an oversized query rather than scanning it', () => {
    expect(rankProjectOptions([orca], 'x'.repeat(4096), [])).toEqual([])
  })
})

describe('sectionProjectOptions', () => {
  const many = Array.from({ length: 7 }, (_, i) => project(`p${i}`, `proj-${i}`, `acme/proj-${i}`))

  it('collapses to a single unlabelled list while a query is live', () => {
    const matches = rankProjectOptions(many, 'proj', [])
    const sections = sectionProjectOptions(matches, 'proj', ['p3'])
    expect(sections).toHaveLength(1)
    expect(sections[0]?.heading).toBeNull()
  })

  it('splits into Recent/Projects once the list is long enough to warrant it', () => {
    const matches = rankProjectOptions(many, '', ['p3', 'p5'])
    const sections = sectionProjectOptions(matches, '', ['p3', 'p5'])
    expect(sections.map((s) => s.heading)).toEqual(['Recent', 'Projects'])
    expect(sections[0]?.items.map((i) => i.option.id)).toEqual(['p3', 'p5'])
  })

  it('keeps a short list unsectioned', () => {
    const matches = rankProjectOptions([orca, relay], '', ['relay'])
    expect(sectionProjectOptions(matches, '', ['relay'])).toHaveLength(1)
  })
})

describe('getAmbiguousProjectOptionIds', () => {
  it('flags only ids whose display name repeats', () => {
    const a = project('a', 'scratch', '~/code/scratch')
    const b = project('b', 'scratch', '~/src/scratch')
    const ids = getAmbiguousProjectOptionIds([a, b, orca])
    expect(ids).toEqual(new Set(['a', 'b']))
  })
})

describe('splitDetailForElision', () => {
  it('keeps the last two segments so sibling paths stay distinguishable', () => {
    const split = splitDetailForElision('~/Developer/work/acme/monorepo/services/checkout-api')
    expect(split?.tail).toBe('services/checkout-api')
  })

  it('leaves short or shallow details alone', () => {
    expect(splitDetailForElision('stablyai/orca')).toBeNull()
    expect(splitDetailForElision('3 hosts configured')).toBeNull()
  })
})
