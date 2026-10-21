import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RenderRow } from './render-row'
import { groupArchivedMachineHosts } from './archived-machine-hosts'

function host(hostId: ExecutionHostId): RenderRow {
  return {
    type: 'host-header',
    key: `host:${hostId}`,
    hostId,
    kind: 'ssh',
    label: hostId,
    detail: '',
    health: 'available',
    collapsed: false,
    count: 1
  }
}

const summarize = (rows: RenderRow[]): string[] =>
  rows.map((row) => (row.type === 'host-header' ? row.hostId : row.type))

describe('groupArchivedMachineHosts', () => {
  const rows = [host('local'), host('ssh:old'), host('ssh:live')]

  it('folds archived machines into one row at the end, closed by default', () => {
    const grouped = groupArchivedMachineHosts(rows, new Set(['ssh:old']), false)
    expect(summarize(grouped)).toEqual(['local', 'ssh:live', 'archived-machines'])
    expect(grouped.at(-1)).toMatchObject({ count: 1, expanded: false })
  })

  it('lists their sections under the row once opened', () => {
    const grouped = groupArchivedMachineHosts(rows, new Set(['ssh:old']), true)
    expect(summarize(grouped)).toEqual(['local', 'ssh:live', 'archived-machines', 'ssh:old'])
  })

  it('leaves lists without archived machines alone', () => {
    expect(summarize(groupArchivedMachineHosts(rows, new Set(), false))).toEqual(summarize(rows))
  })
})
