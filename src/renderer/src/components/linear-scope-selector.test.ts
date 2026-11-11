import { describe, expect, it } from 'vitest'
import type { LinearTeam } from '../../../shared/linear/workspace-types'

import {
  LINEAR_SCOPE_TEAM_FILTER_QUERY_MAX_BYTES,
  filterLinearScopeTeams
} from './linear-scope-selector'

describe('LinearScopeSelector helpers', () => {
  it('rejects oversized pasted filters before reading team text', () => {
    const oversizedQuery = 'secret-linear-scope'.repeat(LINEAR_SCOPE_TEAM_FILTER_QUERY_MAX_BYTES)
    const throwingTeams = [
      {
        id: 'secret',
        workspaceId: 'workspace-1',
        get name(): string {
          throw new Error('oversized Linear scope filters must not scan team names')
        },
        get key(): string {
          throw new Error('oversized Linear scope filters must not scan team keys')
        },
        get workspaceName(): string {
          throw new Error('oversized Linear scope filters must not scan workspace names')
        }
      }
    ] as LinearTeam[]

    expect(filterLinearScopeTeams(throwingTeams, oversizedQuery, new Map())).toEqual([])
  })
})
