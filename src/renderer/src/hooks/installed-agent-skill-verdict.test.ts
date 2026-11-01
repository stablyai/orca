import { describe, expect, it } from 'vitest'
import type { SkillDiscoverySource, SkillSourceKind } from '../../../shared/skills'

import {
  getInstalledAgentSkillVerdict,
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

describe('getInstalledAgentSkillVerdict', () => {
  it('ignores an unreadable root outside the queried source kinds', () => {
    expect(unverifiable({ sources: [source('repo', 'unavailable')] })).toBe(false)
  })

  // Pre-answer failure leaves sources empty, so missing results need a separate unknown check.
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
})

describe('installed-skill verdict while a WSL distro is stopped (E9)', () => {
  // What main answers for a blocked WSL target or a blocked repo root: never read, never "missing".
  const stoppedDistroSource = (sourceKind: SkillSourceKind): SkillDiscoverySource => ({
    id: `wsl-unavailable-${sourceKind}-ubuntu`,
    label: 'WSL Ubuntu',
    path: '',
    sourceKind,
    providers: [],
    owner: null,
    exists: false,
    skippedReason: 'unavailable'
  })

  it('doubts a negative answer instead of confirming the skill is not installed', () => {
    const verdict = getInstalledAgentSkillVerdict(
      scan({ sources: [stoppedDistroSource('home'), stoppedDistroSource('repo')] })
    )
    expect(verdict.installedUnverifiable).toBe(true)
    expect(verdict.error).toBe('A skill folder did not respond, so this status may be incomplete.')
  })
})
