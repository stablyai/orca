import { describe, expect, it } from 'vitest'
import type { MachineGroupOption, MachineOption } from '@/lib/machines/machine-group-options'
import { buildMachineRows } from './run-target-machine-rows'

const PROVIDER = 'plugin:omarchy/omarchy' as const

function machine(name: string, overrides: Partial<MachineOption> = {}): MachineOption {
  return {
    providerKey: PROVIDER,
    machineId: name,
    environmentId: null,
    locationKey: null,
    name,
    state: 'running',
    lifetime: 'persistent',
    expiresAt: null,
    ...overrides
  }
}

function group(overrides: Partial<MachineGroupOption> = {}): MachineGroupOption {
  return {
    key: PROVIDER,
    providerKey: PROVIDER,
    name: 'Omarchy',
    environmentId: null,
    serverName: null,
    status: { kind: 'ready' },
    machines: ['a', 'b', 'c', 'd', 'e'].map((name) => machine(name)),
    archived: [machine('old', { state: 'archived' })],
    canCreate: true,
    ...overrides
  }
}

function summarize(rows: ReturnType<typeof buildMachineRows>): string[] {
  return rows.map((row) => (row.kind === 'machine' ? `machine:${row.machine.name}` : row.kind))
}

describe('buildMachineRows', () => {
  it('caps a group at three machines, then Show all and the create row', () => {
    const rows = buildMachineRows({ groups: [group()], query: '', views: {} })
    expect(summarize(rows)).toEqual([
      'machine-group',
      'machine:a',
      'machine:b',
      'machine:c',
      'machine-more',
      'machine-create'
    ])
  })

  it('expands in place and keeps archived machines behind a collapsed row', () => {
    const views = { [PROVIDER]: { expanded: true, archivedOpen: false } }
    const rows = buildMachineRows({ groups: [group()], query: '', views })
    expect(summarize(rows)).toEqual([
      'machine-group',
      'machine:a',
      'machine:b',
      'machine:c',
      'machine:d',
      'machine:e',
      'machine-archived',
      'machine-more',
      'machine-create'
    ])
  })

  it('lists archived machines once their row is opened', () => {
    const views = { [PROVIDER]: { expanded: true, archivedOpen: true } }
    const rows = buildMachineRows({
      groups: [group({ machines: [machine('a')] })],
      query: '',
      views
    })
    expect(summarize(rows)).toEqual([
      'machine-group',
      'machine:a',
      'machine-archived',
      'machine:old',
      'machine-more',
      'machine-create'
    ])
  })

  it('offers Show all when only archived machines are hidden', () => {
    const rows = buildMachineRows({
      groups: [group({ machines: [machine('a')] })],
      query: '',
      views: {}
    })
    expect(summarize(rows)).toContain('machine-more')
  })

  it('shows only the create row for a provider without machines', () => {
    const rows = buildMachineRows({
      groups: [group({ machines: [], archived: [] })],
      query: '',
      views: {}
    })
    expect(summarize(rows)).toEqual(['machine-group', 'machine-create'])
  })

  it('searches every machine, archived ones included, without a cap', () => {
    const rows = buildMachineRows({
      groups: [group({ machines: [machine('pr-1'), machine('pr-2'), machine('x')] })],
      query: 'PR-',
      views: {}
    })
    expect(summarize(rows)).toEqual(['machine-group', 'machine:pr-1', 'machine:pr-2'])
    const archived = buildMachineRows({ groups: [group()], query: 'old', views: {} })
    expect(summarize(archived)).toEqual(['machine-group', 'machine:old'])
  })

  it('drops a group with no search matches', () => {
    expect(buildMachineRows({ groups: [group()], query: 'zzz', views: {} })).toEqual([])
  })

  it('collapses a provider that needs sign-in to its fix row', () => {
    for (const kind of ['sign-in', 'different-account'] as const) {
      const rows = buildMachineRows({ groups: [group({ status: { kind } })], query: '', views: {} })
      expect(summarize(rows)).toEqual(['machine-group', 'machine-sign-in'])
    }
  })

  it('keeps unreachable machines listed with a retry row', () => {
    const rows = buildMachineRows({
      groups: [group({ status: { kind: 'unreachable', lastSeenAt: 1 } })],
      query: '',
      views: {}
    })
    expect(summarize(rows)).toEqual([
      'machine-group',
      'machine:a',
      'machine:b',
      'machine:c',
      'machine-retry'
    ])
  })

  it('points an invalid response at its details row', () => {
    const rows = buildMachineRows({
      groups: [group({ status: { kind: 'invalid-response' } })],
      query: '',
      views: {}
    })
    expect(summarize(rows)).toEqual(['machine-group', 'machine-details'])
  })

  it('leaves a paired server’s account fixes to that server', () => {
    const remote = { environmentId: 'env-2', serverName: 'build-box', key: 'env-2/omarchy' }
    for (const kind of ['sign-in', 'invalid-response'] as const) {
      const rows = buildMachineRows({
        groups: [group({ ...remote, status: { kind } })],
        query: '',
        views: {}
      })
      expect(summarize(rows)).toEqual(['machine-group'])
    }
    const unreachable = buildMachineRows({
      groups: [group({ ...remote, status: { kind: 'unreachable', lastSeenAt: 1 } })],
      query: '',
      views: {}
    })
    expect(summarize(unreachable)).not.toContain('machine-retry')
  })
})
