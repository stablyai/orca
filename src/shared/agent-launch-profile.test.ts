import { describe, expect, it } from 'vitest'
import { captureAgentLaunchProfile, normalizeAgentLaunchProfiles } from './agent-launch-profile'

const managed = {
  id: 'work',
  name: 'Work Claude',
  agent: 'claude',
  hostId: 'local',
  executable: '/opt/bin/claude',
  binding: { kind: 'managed', accountId: 'account-a' }
}
const external = {
  id: 'personal',
  name: 'Personal Codex',
  agent: 'codex',
  hostId: 'local',
  executable: '/opt/bin/codex',
  binding: { kind: 'external', home: '/profiles/personal' }
}

describe('agent launch profiles', () => {
  it('retains both providers and ownership modes across repeated normalization', () => {
    const profiles = normalizeAgentLaunchProfiles([managed, external])
    expect(profiles).toEqual([managed, external])
    expect(normalizeAgentLaunchProfiles(profiles)).toEqual(profiles)
  })

  it.each([
    { ...external, agent: 'unknown' },
    { ...external, hostId: 'unknown' },
    { ...external, executable: 'codex' },
    { ...external, binding: { kind: 'external', home: 'relative' } },
    { ...external, binding: { kind: 'external', home: '/work\nother' } },
    { ...external, binding: { kind: 'external', home: '/work', accountId: 'a' } },
    { ...managed, binding: { kind: 'managed', accountId: 'a', home: '/work' } },
    { ...managed, binding: { kind: 'managed', accountId: '' } },
    { ...managed, name: 'Claude' },
    { ...managed, id: '../work' }
  ])('drops malformed persisted profiles without inventing a default: %j', (value) => {
    expect(normalizeAgentLaunchProfiles([value])).toEqual([])
  })

  it('deduplicates IDs and names without merging accounts', () => {
    expect(
      normalizeAgentLaunchProfiles([
        managed,
        { ...external, id: managed.id },
        external,
        { ...external, id: 'duplicate', name: ' personal codex ' }
      ])
    ).toEqual([managed, external])
  })

  it('captures a deep binding copy before rename, rebind and unlink', () => {
    const profiles = normalizeAgentLaunchProfiles([external])
    const snapshot = captureAgentLaunchProfile(profiles, external.id)
    profiles[0].name = 'Changed'
    if (profiles[0].binding.kind === 'external') {
      profiles[0].binding.home = '/different'
    }
    profiles.splice(0)
    expect(snapshot).toEqual(external)
    expect(() => captureAgentLaunchProfile(profiles, external.id)).toThrow(/no longer exists/)
  })
})
