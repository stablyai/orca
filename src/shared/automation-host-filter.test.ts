import { describe, expect, it } from 'vitest'
import { hostStableKey } from './automation-owner-key'
import type { StableAutomationCatalogRef } from './automation-owner-ref'
import {
  ALL_AUTOMATION_HOSTS_FILTER,
  automationHostFilterStableKey,
  automationHostFiltersEqual,
  parsePersistedAutomationHostFilter,
  toPersistedAutomationHostFilter,
  type AutomationHostFilter
} from './automation-host-filter'

const sshHost: StableAutomationCatalogRef = {
  authority: { kind: 'runtime', environmentId: 'env-1' },
  selector: { kind: 'ssh', targetId: 'ssh:a' }
}
const sshFilter: AutomationHostFilter = { kind: 'host', host: sshHost }

describe('persisted automation host filter', () => {
  it('persists only the stable form as a canonical key', () => {
    expect(toPersistedAutomationHostFilter(sshFilter)).toEqual({
      kind: 'host',
      hostKey: hostStableKey(sshHost)
    })
    expect(toPersistedAutomationHostFilter(ALL_AUTOMATION_HOSTS_FILTER)).toEqual({ kind: 'all' })
  })

  it('round-trips every stable selector kind', () => {
    const filters: AutomationHostFilter[] = [
      { kind: 'host', host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } } },
      { kind: 'host', host: { authority: { kind: 'desktop' }, selector: { kind: 'orphan' } } },
      {
        kind: 'host',
        host: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'a:b' } }
      },
      sshFilter
    ]
    for (const filter of filters) {
      expect(parsePersistedAutomationHostFilter(toPersistedAutomationHostFilter(filter))).toEqual(
        filter
      )
    }
  })

  it.each([
    undefined,
    null,
    'host:desktop:self',
    42,
    {},
    { kind: 'host' },
    { kind: 'host', hostKey: 5 },
    { kind: 'host', hostKey: '' },
    { kind: 'host', hostKey: 'desktop:self' },
    { kind: 'host', hostKey: 'host:runtime' },
    { kind: 'host', hostKey: 'host:desktop:bogus' },
    { kind: 'host', hostKey: 'host:desktop:ssh:%zz' },
    { kind: 'nonsense' }
  ])('falls back to All hosts for malformed value %j without throwing', (value) => {
    expect(parsePersistedAutomationHostFilter(value)).toEqual({ kind: 'all' })
  })

  it('exposes the stable key and compares by it', () => {
    expect(automationHostFilterStableKey(ALL_AUTOMATION_HOSTS_FILTER)).toBeNull()
    expect(automationHostFilterStableKey(sshFilter)).toBe(hostStableKey(sshHost))
    expect(automationHostFiltersEqual(sshFilter, { kind: 'host', host: { ...sshHost } })).toBe(true)
    expect(automationHostFiltersEqual(sshFilter, ALL_AUTOMATION_HOSTS_FILTER)).toBe(false)
  })

  it('does not collide equal target ids across authorities', () => {
    const desktop: AutomationHostFilter = {
      kind: 'host',
      host: { authority: { kind: 'desktop' }, selector: { kind: 'ssh', targetId: 'shared' } }
    }
    const runtime: AutomationHostFilter = {
      kind: 'host',
      host: {
        authority: { kind: 'runtime', environmentId: 'env-1' },
        selector: { kind: 'ssh', targetId: 'shared' }
      }
    }
    expect(automationHostFiltersEqual(desktop, runtime)).toBe(false)
  })
})
