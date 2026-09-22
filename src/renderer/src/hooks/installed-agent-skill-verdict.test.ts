import { describe, expect, it } from 'vitest'
import type { SkillDiscoverySource, SkillSourceKind } from '../../../shared/skills'
import { GLOBAL_AGENT_SKILL_SOURCE_KINDS } from './useInstalledAgentSkills'
import {
  getInstalledAgentSkillVerdict,
  hasUnreadableAgentSkillSource,
  type InstalledAgentSkillScan
} from './installed-agent-skill-verdict'

function source(
  sourceKind: SkillSourceKind,
  skippedReason?: SkillDiscoverySource['skippedReason']
): SkillDiscoverySource {
  return {
    id: `${sourceKind}-root`,
    label: sourceKind,
    path: `/roots/${sourceKind}`,
    sourceKind,
    providers: ['claude'],
    owner: null,
    // An unread root reports `exists`: the host could not prove otherwise.
    exists: true,
    ...(skippedReason ? { skippedReason } : {})
  }
}

function scan(overrides: Partial<InstalledAgentSkillScan> = {}): InstalledAgentSkillScan {
  return {
    enabled: true,
    installed: false,
    settled: true,
    error: null,
    sources: [],
    sourceKinds: ['home'],
    ...overrides
  }
}

const unverifiable = (overrides: Partial<InstalledAgentSkillScan>): boolean =>
  getInstalledAgentSkillVerdict(scan(overrides)).installedUnverifiable
const error = (overrides: Partial<InstalledAgentSkillScan>): string | null =>
  getInstalledAgentSkillVerdict(scan(overrides)).error

describe('hasUnreadableAgentSkillSource', () => {
  it('flags a root that did not answer even though it reports as present', () => {
    expect(hasUnreadableAgentSkillSource([source('home', 'unavailable')])).toBe(true)
  })

  it('ignores roots that were scanned or are genuinely absent', () => {
    expect(
      hasUnreadableAgentSkillSource([
        source('home'),
        { ...source('home'), id: 'gone', exists: false, skippedReason: 'missing' }
      ])
    ).toBe(false)
  })

  it('ignores an unread root outside the scopes the caller asked about', () => {
    expect(
      hasUnreadableAgentSkillSource(
        [source('repo', 'unavailable')],
        GLOBAL_AGENT_SKILL_SOURCE_KINDS
      )
    ).toBe(false)
  })
})

describe('getInstalledAgentSkillVerdict', () => {
  it('treats a complete scan that found nothing as proof of absence', () => {
    expect(unverifiable({ sources: [source('home')] })).toBe(false)
  })

  it('cannot vouch for a negative when a root this query cares about did not answer', () => {
    expect(unverifiable({ sources: [source('home', 'unavailable')] })).toBe(true)
  })

  it('ignores an unreadable root outside the queried source kinds', () => {
    expect(unverifiable({ sources: [source('repo', 'unavailable')] })).toBe(false)
  })

  // The reported bug: `sources` is empty until a result lands, so a scan that
  // errored before answering is invisible to the unreadable-root check.
  it('cannot vouch for a negative when the scan errored before ever answering', () => {
    expect(unverifiable({ settled: false, error: 'scan failed' })).toBe(true)
  })

  it('keeps an answer it already holds when a later refresh fails', () => {
    expect(unverifiable({ settled: true, error: 'scan failed' })).toBe(false)
  })

  it('stays silent while a first scan is still pending with no error', () => {
    expect(unverifiable({ settled: false })).toBe(false)
  })

  it('takes finding the skill as proof, whatever else failed', () => {
    expect(unverifiable({ installed: true, settled: false, error: 'scan failed' })).toBe(false)
  })

  it('says nothing about a query that is switched off', () => {
    expect(unverifiable({ enabled: false, sources: [source('home', 'unavailable')] })).toBe(false)
  })

  it("prefers the scan's own failure over the advisory", () => {
    expect(error({ settled: false, error: 'scan failed' })).toBe('scan failed')
  })

  it('advises when an unreadable root is the only reason the answer is empty', () => {
    expect(error({ sources: [source('home', 'unavailable')] })).toContain('did not respond')
  })

  it('stays quiet for a trustworthy negative', () => {
    expect(error({ sources: [source('home')] })).toBeNull()
  })
})
