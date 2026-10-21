import { describe, expect, it } from 'vitest'
import { getRepoRoutingConnectionId } from './execution-host'

describe('getRepoRoutingConnectionId', () => {
  it.each([
    ['legacy connectionId', { connectionId: 'gpu' }, 'gpu'],
    ['ssh executionHostId only', { executionHostId: 'ssh:gpu' as const }, 'gpu'],
    [
      'runtime host with nested SSH',
      { executionHostId: 'runtime:env' as const, connectionId: 'gpu' },
      'gpu'
    ],
    [
      'local with a stale connectionId',
      { executionHostId: 'local' as const, connectionId: 'gpu' },
      'gpu'
    ],
    ['local', { executionHostId: 'local' as const }, null],
    ['runtime host', { executionHostId: 'runtime:env' as const }, null],
    ['unstamped', {}, null]
  ])('%s', (_label, repo, expected) => {
    expect(getRepoRoutingConnectionId(repo)).toBe(expected)
  })

  it('never answers local for a row whose raw connectionId is set', () => {
    for (const executionHostId of [
      undefined,
      'local',
      'runtime:env',
      'ssh:gpu',
      'ssh:other'
    ] as const) {
      expect(getRepoRoutingConnectionId({ executionHostId, connectionId: 'gpu' })).not.toBeNull()
    }
  })

  it('lets executionHostId win on a contradictory SSH row, as getRepoExecutionHostId does', () => {
    expect(getRepoRoutingConnectionId({ executionHostId: 'ssh:b', connectionId: 'a' })).toBe('b')
  })
})
