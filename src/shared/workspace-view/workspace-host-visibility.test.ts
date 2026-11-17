import { describe, expect, it } from 'vitest'
import { cycleVisibleHostRow } from './workspace-host-visibility'
import type { MergedExecutionHost } from '../execution-host/managed-orcad-execution-host'

const hosts: MergedExecutionHost[] = [
  { id: 'local' },
  { id: 'ssh:orb', aliasHostIds: ['runtime:orb-server'] },
  { id: 'runtime:orb-server', mergedIntoHostId: 'ssh:orb' },
  { id: 'ssh:github' }
]

describe('cycleVisibleHostRow', () => {
  it('walks All hosts through each row alone and back to All hosts', () => {
    expect(cycleVisibleHostRow(hosts, null)).toEqual(['local'])
    expect(cycleVisibleHostRow(hosts, ['local'])).toEqual(['ssh:orb', 'runtime:orb-server'])
    expect(cycleVisibleHostRow(hosts, ['runtime:orb-server'])).toEqual(['ssh:github'])
    expect(cycleVisibleHostRow(hosts, ['ssh:github'])).toBeNull()
  })

  it('resets a multi-host selection to All hosts', () => {
    expect(cycleVisibleHostRow(hosts, ['local', 'ssh:github'])).toBeNull()
  })

  it('treats a saved list that covers every row as All hosts', () => {
    expect(cycleVisibleHostRow(hosts, ['local', 'ssh:orb', 'ssh:github'])).toEqual(['local'])
  })

  it('does nothing when only one host can be picked', () => {
    expect(cycleVisibleHostRow([{ id: 'local' }], null)).toBeUndefined()
    expect(cycleVisibleHostRow([{ id: 'local' }], ['local'])).toBeUndefined()
  })

  it('clears a filter left on a host that is gone', () => {
    expect(cycleVisibleHostRow([{ id: 'local' }], ['ssh:removed'])).toBeNull()
  })

  it('clears a filter that mixes a live host with a removed one', () => {
    expect(cycleVisibleHostRow(hosts, ['local', 'ssh:removed'])).toBeNull()
  })

  it('keeps cycling when the saved list names a merged row by its alias', () => {
    expect(cycleVisibleHostRow(hosts, ['ssh:orb', 'runtime:orb-server'])).toEqual(['ssh:github'])
  })

  it('does nothing before any host rows are known', () => {
    expect(cycleVisibleHostRow([], ['local'])).toBeUndefined()
  })
})
