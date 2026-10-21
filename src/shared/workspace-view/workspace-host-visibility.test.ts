import { describe, expect, it } from 'vitest'
import { toggleAllVisibleHosts, toggleVisibleHostRow } from './workspace-host-visibility'

const hosts = [{ id: 'local' as const }, { id: 'ssh:box' as const }]

describe('the Hosts checklist', () => {
  it('"All hosts" shows every host, or narrows to the first when already showing all', () => {
    expect(toggleAllVisibleHosts(hosts, ['ssh:box'])).toBeNull()
    expect(toggleAllVisibleHosts(hosts, null)).toEqual(['local'])
    expect(toggleAllVisibleHosts([], null)).toBeUndefined()
  })

  it('refuses to hide the last shown host and collapses a full list back to every host', () => {
    expect(toggleVisibleHostRow(hosts, ['local'], hosts[0])).toBeUndefined()
    expect(toggleVisibleHostRow(hosts, ['local'], hosts[1])).toBeNull()
  })
})
