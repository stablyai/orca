import { expect, it } from 'vitest'
import { resolveLinearIssueAttributeFilterPrimaryTeam } from './linear-issue-attribute-filter-primary-team'

it('selects a primary team without pairwise membership checks or sorting all teams', () => {
  let reads = 0
  let nameReads = 0
  const availableTeams = Array.from({ length: 1000 }, (_, index) => ({
    id: `team-${index}`,
    key: String(index),
    get name() {
      nameReads += 1
      return String((index * 173) % 1000).padStart(4, '0')
    }
  }))
  const selectedTeamIds = new Proxy(
    availableTeams.map((team) => team.id),
    {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          reads += 1
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap default forward.
        return Reflect.get(target, key, receiver)
      }
    }
  )
  expect(resolveLinearIssueAttributeFilterPrimaryTeam({ selectedTeamIds, availableTeams })).toBe(
    availableTeams[0]
  )
  expect(reads).toBeLessThanOrEqual(1000)
  expect(nameReads).toBeLessThan(5000)
})
