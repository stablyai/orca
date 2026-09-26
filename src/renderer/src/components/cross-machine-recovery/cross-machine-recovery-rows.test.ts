import { describe, expect, it } from 'vitest'
import { buildRecoverySourceGroups, workspaceDisabledReason } from './cross-machine-recovery-rows'
import { recoveryTestItem } from './cross-machine-recovery-test-items'

describe('buildRecoverySourceGroups', () => {
  it('groups source → workspace → sessions with unreachable sources first, then newest human use', () => {
    const groups = buildRecoverySourceGroups([
      recoveryTestItem({
        host: 'old',
        workspace: 'a',
        sessions: [{ id: 'o1', human: '2026-09-20T00:00:00Z' }]
      }),
      recoveryTestItem({
        host: 'new',
        workspace: 'b',
        sessions: [{ id: 'n1', human: '2026-09-25T00:00:00Z' }]
      }),
      recoveryTestItem({
        host: 'new',
        workspace: 'c',
        sessions: [{ id: 'n2', human: '2026-09-26T00:00:00Z' }]
      }),
      recoveryTestItem({
        host: 'gone',
        reachable: false,
        workspace: 'd',
        sessions: [{ id: 'g1', human: null }]
      })
    ])
    expect(groups.map((group) => group.hostId)).toEqual(['gone', 'new', 'old'])
    expect(groups[1].workspaces.map((row) => row.selector)).toEqual(['new/c', 'new/b'])
    expect(groups[1].newestHumanActivityAt).toBe(Date.parse('2026-09-26T00:00:00Z'))
  })

  it('defaults resume to the most recent human session that is not live locally', () => {
    const [group] = buildRecoverySourceGroups([
      recoveryTestItem({
        host: 'h',
        workspace: 'w',
        sessions: [
          { id: 'older', human: '2026-09-24T00:00:00Z' },
          { id: 'live', human: '2026-09-26T00:00:00Z', collision: true },
          { id: 'recent', human: '2026-09-25T00:00:00Z' },
          { id: 'never', human: null }
        ]
      })
    ])
    const [row] = group.workspaces
    expect(row.defaultResumeSessionId).toBe('recent')
    expect(row.sessions.map((session) => session.sessionId)).toEqual([
      'live',
      'recent',
      'older',
      'never'
    ])
  })

  it('reports why a not-ready workspace is disabled', () => {
    const [group] = buildRecoverySourceGroups([
      recoveryTestItem({
        host: 'h',
        workspace: 'w',
        ready: false,
        missing: ['transcript'],
        sessions: []
      })
    ])
    expect(workspaceDisabledReason(group.workspaces[0])).toEqual({
      kind: 'not-ready',
      missing: ['transcript']
    })
  })
})
