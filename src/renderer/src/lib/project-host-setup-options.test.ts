import { buildProjectGroupingIndex } from '../../../shared/project-section-grouping'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as dedupeRows from './project-host-setup-row-dedupe'
import { getExecutionHostLabel, type ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { buildProjectHostSetupOptions } from './project-host-setup-options'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

function repo(id: string): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1
  }
}

function setup(
  id: string,
  projectId: string,
  hostId: ExecutionHostId,
  repoId: string,
  overrides: Partial<ProjectHostSetup> = {}
): ProjectHostSetup {
  return {
    id,
    projectId,
    hostId,
    repoId,
    path: `/repos/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function host(
  id: ExecutionHostId,
  overrides: Partial<ExecutionHostRegistryEntry> = {}
): ExecutionHostRegistryEntry {
  return {
    id,
    kind: id === 'local' ? 'local' : id.startsWith('ssh:') ? 'ssh' : 'runtime',
    label: id === 'local' ? LOCAL_HOST_LABEL : id.replace(/^ssh:|^runtime:/, ''),
    detail: id === 'local' ? 'This computer' : 'Host',
    health: id === 'local' ? 'local' : 'available',
    ...overrides
  }
}

it('keeps an eligible alias as a concrete run target inside its canonical group', () => {
  const projectId = 'github:org/app'
  const projectHostSetups = [
    setup('canonical', projectId, 'local', 'canonical', { path: '/app' }),
    setup('alias', 'repo:alias', 'local', 'alias', { path: '/app' })
  ]
  const grouping = buildProjectGroupingIndex({
    projects: [
      { id: projectId, displayName: 'App' },
      { id: 'repo:alias', displayName: 'App' }
    ],
    projectHostSetups
  })
  expect(
    buildProjectHostSetupOptions({
      projectId,
      groupKey: `project:${projectId}`,
      grouping,
      projectHostSetups,
      eligibleRepos: [repo('alias')],
      hosts: [host('local')]
    })
  ).toMatchObject([{ kind: 'ready', repoId: 'alias', id: 'alias', hostId: 'local' }])
})

describe('buildProjectHostSetupOptions', () => {
  it('keeps distinct same-host checkout paths available for explicit selection', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('main-checkout'), repo('worktree-a'), repo('worktree-b')],
      hosts: [host('local')],
      projectHostSetups: [
        setup('main', 'project-1', 'local', 'main-checkout', { path: '/Users/dev/projects/orca' }),
        setup('dup-a', 'project-1', 'local', 'worktree-a', {
          path: '/Users/dev/worktrees/pr-1908'
        }),
        setup('dup-b', 'project-1', 'local', 'worktree-b', { path: '/Users/dev/worktrees/pr-3235' })
      ]
    })

    expect(options).toEqual([
      expect.objectContaining({ id: 'main', kind: 'ready', label: LOCAL_HOST_LABEL }),
      expect.objectContaining({ id: 'dup-a', kind: 'ready' }),
      expect.objectContaining({ id: 'dup-b', kind: 'ready' })
    ])
  })

  it('keeps all checkouts when a project is set up on several hosts', () => {
    const options = buildProjectHostSetupOptions({
      projectId: 'project-1',
      eligibleRepos: [repo('local-repo'), repo('local-dup'), repo('remote-repo')],
      hosts: [host('local'), host('ssh:builder', { label: 'Builder' })],
      projectHostSetups: [
        setup('local', 'project-1', 'local', 'local-repo'),
        setup('local-dup', 'project-1', 'local', 'local-dup'),
        setup('remote', 'project-1', 'ssh:builder', 'remote-repo')
      ]
    })

    expect(options.map((option) => option.id)).toEqual(['local-dup', 'local', 'remote'])
  })
})

afterEach(() => vi.restoreAllMocks())

it.each([
  [100, 100],
  [1000, 100],
  [100, 1000],
  [1000, 1000]
])('bounds the actual ready picker merged clones at S=%i H=%i', (count, hostCount) => {
  let reads = 0
  let dedupeReads = 0
  let dedupeInput = 0
  const original = dedupeRows.dedupeReadySetupRows
  vi.spyOn(dedupeRows, 'dedupeReadySetupRows').mockImplementation((options, hosts) => {
    dedupeInput = options.length
    const counted = options.map((option) => ({
      ...option,
      get hostId() {
        reads++
        return option.hostId
      },
      get path() {
        reads++
        return option.path
      }
    }))
    const rows = original(counted, hosts)
    dedupeReads = reads
    return rows
  })
  const canonical = 'runtime:server'
  const alias = 'ssh:alias'
  const projectHostSetups = Array.from({ length: count }, (_, i) => [
    setup(`alias-${i}`, 'app', alias, `alias-${i}`, { path: `/checkout/${i}` }),
    setup(`server-${i}`, 'app', canonical, `server-${i}`, { path: `/checkout/${i}` })
  ]).flat()
  const eligibleRepos = projectHostSetups.map((entry) => ({
    ...repo(entry.repoId),
    executionHostId: entry.hostId,
    path: entry.path
  }))
  const hosts = [
    host(alias, { mergedIntoHostId: canonical }),
    host(canonical),
    ...Array.from({ length: hostCount }, (_, i) => host(`ssh:other-${i}`))
  ]
  const options = buildProjectHostSetupOptions({
    projectId: 'app',
    projectHostSetups,
    eligibleRepos,
    hosts
  })
  expect(dedupeInput).toBe(2 * count)
  expect(dedupeReads).toBeGreaterThanOrEqual(2 * count)
  expect(dedupeReads).toBeLessThanOrEqual(28 * count)
  const ready = options.filter((option) => option.kind === 'ready')
  expect(ready).toHaveLength(count)
  expect(options.filter((option) => option.kind === 'needs-setup')).toHaveLength(hostCount)
  expect(new Set(ready.map((option) => option.hostId))).toEqual(new Set([canonical]))
  for (const option of ready) {
    const suffix = option.id.slice('server-'.length)
    expect(option).toMatchObject({
      path: `/checkout/${suffix}`,
      repoId: `server-${suffix}`,
      aliasSetups: [{ id: `alias-${suffix}`, hostId: alias }]
    })
  }
  process.stdout.write(
    `PG6-E ${JSON.stringify({ count, hostCount, dedupeInput, dedupeReads, ready: ready.length })}\n`
  )
})
