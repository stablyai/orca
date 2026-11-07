/**
 * Issue #8986 — OMP terminal tab agent status flashes; ghost sidebar agent.
 *
 * OMP (unlike Codex) drives synthetic working titles from hooks AND emits
 * native OSC titles. detectAgentStatusFromTitle maps braille-spinner frames
 * to working and bare "OMP" / ready labels to idle — so competing frames
 * thrash the tab badge between working and idle.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/shared/repro-8986-omp-status-flash.test.ts
 */
import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle } from './agent-title-status'
import {
  shouldDriveSyntheticAgentTitleFromHook,
  getSyntheticAgentTerminalTitle,
  SYNTHETIC_AGENT_TITLE_PROFILES
} from './synthetic-agent-title'
import { getPiCompatibleSyntheticAgentStatus } from './pi-compatible-synthetic-title'

describe('issue #8986 OMP status flash from competing title frames', () => {
  it('OMP drives synthetic titles while working (Codex does not)', () => {
    expect(shouldDriveSyntheticAgentTitleFromHook('omp', 'working')).toBe(true)
    expect(shouldDriveSyntheticAgentTitleFromHook('codex', 'working')).toBe(false)
    expect(SYNTHETIC_AGENT_TITLE_PROFILES.omp.synthesizeWorkingTitle).not.toBe(false)
    expect(SYNTHETIC_AGENT_TITLE_PROFILES.codex.synthesizeWorkingTitle).toBe(false)
  })

  it('oscillates working ↔ idle across native/synthetic OMP title frames', () => {
    const frames = [
      'OMP ready', // synthetic idle
      '\u280b OMP', // synthetic spinner working
      'OMP', // bare collapsed label → idle (pi-compatible)
      '\u28ff OMP - action required', // would be permission if matched, but braille first
      '\u2801 working on task — OMP', // braille → working via general path
      'OMP idle'
    ]

    const statuses = frames.map((t) => detectAgentStatusFromTitle(t))
    // Must include both working and idle across a normal agent turn.
    expect(statuses).toContain('working')
    expect(statuses).toContain('idle')

    // Adjacent synthetic spinner vs ready label thrash (core flash).
    expect(detectAgentStatusFromTitle('\u280b OMP')).toBe('working')
    expect(detectAgentStatusFromTitle('OMP ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('OMP')).toBe('idle')
  })

  it('pi-compatible helper: braille OMP is working, bare/ready is idle', () => {
    expect(getPiCompatibleSyntheticAgentStatus('\u280b OMP')).toBe('working')
    expect(getPiCompatibleSyntheticAgentStatus('OMP ready')).toBe('idle')
    expect(getPiCompatibleSyntheticAgentStatus('OMP')).toBe('idle')
    expect(getPiCompatibleSyntheticAgentStatus('OMP - action required')).toBe('permission')
  })

  it('getSyntheticAgentTerminalTitle does not stabilize working (returns null)', () => {
    // Working titles are spinner-fabricated elsewhere; terminal titles only
    // cover done/permission — so working relies on ephemeral spinner frames.
    expect(getSyntheticAgentTerminalTitle('omp', 'working')).toBeNull()
    expect(getSyntheticAgentTerminalTitle('omp', 'done')).toBe('OMP ready')
    expect(getSyntheticAgentTerminalTitle('omp', 'waiting')).toBe('OMP - action required')
  })

  it('OMP shares pi-compatible title identity group (cross-agent title churn risk)', () => {
    expect(SYNTHETIC_AGENT_TITLE_PROFILES.omp.titleIdentityGroup).toBe('pi-compatible')
    expect(SYNTHETIC_AGENT_TITLE_PROFILES.pi.titleIdentityGroup).toBe('pi-compatible')
  })
})
