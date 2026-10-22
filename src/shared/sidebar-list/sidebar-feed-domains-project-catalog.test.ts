import { describe, expect, it } from 'vitest'
import { readSidebarFeedDomains } from './sidebar-feed-domains'
import type { InstalledSidebarInputs } from './sidebar-inputs-feed-installer'

const repo = (id: string) => ({ id, path: `/${id}`, displayName: id, kind: 'git' })
const group = (id: string, name: string) => ({
  id,
  name,
  parentPath: null,
  executionHostId: 'local',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
})

function installed(catalog: Map<string, unknown>): InstalledSidebarInputs {
  return {
    generation: 'g',
    revision: 1,
    schemaVersion: 1,
    semanticsVersion: 1,
    domains: new Map([['projectCatalog', catalog]])
  }
}

describe('projectCatalog domain read', () => {
  it('a group rename keeps every repo object and re-parses only the groups', () => {
    const repos = [repo('a'), repo('b')]
    const first = installed(
      new Map<string, unknown>([
        ['repos', repos],
        ['projects', []],
        ['setups', []],
        ['projectOrderBy', 'manual'],
        ['projectGroups', [group('g1', 'One')]]
      ])
    )
    const firstDomains = readSidebarFeedDomains(first)
    const second = installed(
      new Map<string, unknown>([
        ['repos', repos],
        ['projects', []],
        ['setups', []],
        ['projectOrderBy', 'manual'],
        ['projectGroups', [group('g1', 'Renamed')]]
      ])
    )
    const secondDomains = readSidebarFeedDomains(second, {
      installed: first,
      domains: firstDomains
    })

    expect(secondDomains.projectCatalog?.repos).toBe(firstDomains.projectCatalog?.repos)
    expect(secondDomains.projectCatalog?.projectGroups?.[0]?.name).toBe('Renamed')
  })

  it('reads null when the domain is absent', () => {
    expect(readSidebarFeedDomains(installed(new Map())).projectCatalog).toBeNull()
  })
})
