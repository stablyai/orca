import type {
  HostSectionRow,
  HostSectionOption
} from '../../../../shared/sidebar-list/host-section-rows'

import type { Repo } from '../../../../shared/repo-types'
import {
  hosts,
  otherRepo,
  groupingFor,
  prepareSections,
  sectionHosts
} from './host-section-project-header-test-fixtures'
import { expect, it, vi } from 'vitest'

import {
  type ProjectSectionModel,
  buildProjectGroupingIndex
} from '../../../../shared/project-section-grouping'

import * as sectionEmitter from '../../../../shared/sidebar-list/group-sections'
import { type ExecutionHostId, getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  repo,
  remoteRepo,
  worktree,
  remoteWorktree,
  project
} from './worktree-list-groups-test-fixtures'
it.each(['distinct', 'same-id', 'alias'] as const)(
  'M2-1 uses the selected qualified pending row for %s, expanded and collapsed',
  (variant) => {
    const local = { ...repo, executionHostId: 'local' as const }
    const pending = { ...remoteRepo, id: variant === 'same-id' ? local.id : remoteRepo.id }
    const alias = { ...pending, id: 'ssh-alias' }
    const selected = variant === 'alias' ? alias : pending
    const entries = variant === 'alias' ? [local, pending, alias] : [local, pending]
    const repoMap = new Map([...entries, local].map((entry) => [entry.id, entry]))
    const model = groupingFor(entries)
    if (variant === 'alias') {
      expect(buildProjectGroupingIndex(model).groups[0].members).toHaveLength(2)
    }
    const plan = prepareSections(entries, [{ ...worktree, hostId: 'local' }], {
      repoMap,
      projectGrouping: model,
      pendingCreations: [{ creationId: 'create', repoId: selected.id, hostId: 'ssh:gpu-vm' }]
    })
    for (const collapsed of [false, true]) {
      const raw = plan.render(new Set(collapsed ? [`project:${project.id}`] : []))
      const rows = sectionHosts(raw)
      const headers = rows.filter((row) => row.type === 'header')
      expect(headers.map((row) => [row.key, row.hostId, row.repo])).toEqual([
        [`project:${project.id}`, 'local', local],
        [`project:${project.id}`, 'ssh:gpu-vm', selected]
      ])
      expect(headers[1]).toMatchObject({ count: 0, worktreeIds: [] })
      expect(rows.filter((row) => row.type === 'pending-creation').map((row) => row.repo)).toEqual(
        collapsed ? [] : [selected]
      )
    }
  }
)

it.each(['host', 'folder'] as const)(
  'M2-2 excludes foreign imported/external twin notices in %s mode before collapse',
  (mode) => {
    const local = { ...repo, id: 'twin', executionHostId: 'local' as const }
    const ssh = { ...remoteRepo, id: local.id }
    const entries = [local, ssh]
    const model = groupingFor(entries, mode)
    const index = buildProjectGroupingIndex(model)
    const localKey = index.groupByRepoHost.get(`local\0${local.id}`)!.key
    const sshKey = index.groupByRepoHost.get(`ssh:gpu-vm\0${ssh.id}`)!.key
    for (const notice of ['imported', 'external', 'both']) {
      const plan = prepareSections(entries, [{ ...worktree, repoId: local.id, hostId: 'local' }], {
        repoMap: new Map([[local.id, local]]),
        projectGrouping: model,
        importedWorktreesByRepo: new Map(
          notice !== 'external' ? [[ssh.id, { repo: ssh, hiddenWorktrees: [] }]] : []
        ),
        newExternalWorktreesInboxByRepo: new Map(
          notice !== 'imported' ? [[ssh.id, { repo: ssh, inboxWorktrees: [] }]] : []
        )
      })
      for (const collapsed of [false, true]) {
        const rows = sectionHosts(plan.render(new Set(collapsed ? [localKey, sshKey] : [])))
        expect(
          rows.filter((row) => row.type === 'header').map((row) => [row.key, row.hostId, row.repo])
        ).toEqual([
          [localKey, 'local', local],
          [sshKey, 'ssh:gpu-vm', ssh]
        ])
        expect(
          rows
            .filter(
              (row) =>
                row.type === 'imported-worktrees-card' ||
                row.type === 'new-external-worktrees-inbox'
            )
            .map((row) => row.repo)
        ).toEqual(collapsed ? [] : notice === 'both' ? [ssh, ssh] : [ssh])
      }
    }
  }
)

it('keeps the first valid SSH raw-map candidate ahead of a later admitted notice', () => {
  const b = { ...remoteRepo, id: 'b' }
  const c = { ...remoteRepo, id: 'c', path: '/ssh/c' }
  const entries = [repo, b, c]
  const plan = prepareSections(entries, [worktree], {
    projectGrouping: groupingFor(entries),
    placeholderRepoIds: new Set([b.id]),
    importedWorktreesByRepo: new Map([
      [c.id, { repo: c, hiddenWorktrees: [] }],
      [b.id, { repo: b, hiddenWorktrees: [] }]
    ]),
    newExternalWorktreesInboxByRepo: new Map([
      [c.id, { repo: c, inboxWorktrees: [] }],
      [b.id, { repo: b, inboxWorktrees: [] }]
    ]),
    pendingCreations: [{ creationId: 'b-first', repoId: b.id, hostId: 'ssh:gpu-vm' }]
  })
  const expanded = plan.render(new Set())
  expect(
    expanded.flatMap((row) =>
      row.type === 'imported-worktrees-card' || row.type === 'new-external-worktrees-inbox'
        ? [[row.type, row.repo.id]]
        : row.type === 'pending-creation'
          ? [[row.type, row.repo?.id]]
          : []
    )
  ).toEqual([
    ['imported-worktrees-card', b.id],
    ['imported-worktrees-card', c.id],
    ['new-external-worktrees-inbox', b.id],
    ['new-external-worktrees-inbox', c.id],
    ['pending-creation', b.id]
  ])
  expect(
    sectionHosts(plan.render(new Set()))
      .filter((row) => row.type === 'header')
      .find((row) => row.hostId === 'ssh:gpu-vm')?.repo
  ).toBe(b)
})

it('I3 never treats the occurrence owner as proof that its raw-fallback concrete Repo belongs to that section', () => {
  const local = { ...repo, id: 'twin', executionHostId: 'local' as const }
  const ssh = { ...remoteRepo, id: local.id }
  const model = groupingFor([local, ssh], 'host')
  const sshKey = buildProjectGroupingIndex(model).groupByRepoHost.get(`ssh:gpu-vm\0${ssh.id}`)!.key
  for (const present of [false, true]) {
    const entries = present ? [local, ssh] : [local]
    const plan = prepareSections(
      entries,
      [{ ...worktree, repoId: local.id, hostId: 'ssh:gpu-vm' }],
      {
        repoMap: new Map([[local.id, local]]),
        projectGrouping: model,
        pendingCreations: [{ creationId: 'local-only', repoId: local.id, hostId: 'local' }]
      }
    )
    for (const collapsed of [false, true]) {
      const raw = plan.render(new Set(collapsed ? [sshKey] : []))
      const header = raw.filter((row) => row.type === 'header').find((row) => row.key === sshKey)
      expect(header?.repo).toBe(present ? ssh : undefined)
      expect(header?.hostRepos?.has('local') ?? false).toBe(false)
      expect(
        sectionHosts(raw)
          .filter((row) => row.type === 'header')
          .filter((row) => row.key === sshKey)
          .every((row) => row.repo !== local)
      ).toBe(true)
    }
  }
})

it('keeps group.items candidate order even when occurrence traversal puts a main worktree first', () => {
  const first = { ...remoteRepo, id: 'ssh-first', path: '/ssh/first' }
  const main = { ...remoteRepo, id: 'ssh-main', path: '/ssh/main' }
  const entries = [repo, first, main]
  const plan = prepareSections(
    entries,
    [
      worktree,
      {
        ...remoteWorktree,
        id: 'ordinary',
        repoId: first.id,
        hostId: 'ssh:gpu-vm',
        isMainWorktree: false
      },
      { ...remoteWorktree, id: 'main', repoId: main.id, hostId: 'ssh:gpu-vm', isMainWorktree: true }
    ],
    { projectGrouping: groupingFor(entries) }
  )
  expect(
    sectionHosts(plan.render(new Set()))
      .filter((row) => row.type === 'header')
      .find((row) => row.hostId === 'ssh:gpu-vm')?.repo
  ).toBe(first)
})

it('validates concrete targets when same-host foreign-project lineage is displayed under its parent', () => {
  const childRepo = { ...repo, id: 'child-repo', path: '/child' }
  const parent = {
    ...worktree,
    id: 'parent',
    instanceId: 'parent-instance',
    hostId: 'local' as const
  }
  const child = {
    ...worktree,
    id: 'child',
    repoId: childRepo.id,
    instanceId: 'child-instance',
    hostId: 'local' as const
  }
  const model = groupingFor([repo, childRepo])
  const childProject = { ...project, id: 'child-project', sourceRepoIds: [childRepo.id] }
  model.projects = [project, childProject]
  model.projectHostSetups = model.projectHostSetups.map((setup) =>
    setup.repoId === childRepo.id ? { ...setup, projectId: childProject.id } : setup
  )
  for (const present of [false, true]) {
    const plan = prepareSections(present ? [repo, childRepo] : [childRepo], [parent, child], {
      projectGrouping: model,
      nestLineage: true,
      lineageById: {
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'cli',
          capture: { source: 'terminal-context', confidence: 'inferred' },
          createdAt: 1
        }
      }
    })
    const raw = plan.render(new Set())
    expect(
      raw.filter((row) => row.type === 'item').map((row) => [row.worktree.id, row.depth])
    ).toEqual([
      [parent.id, 0],
      [child.id, 1]
    ])
    const header = raw
      .filter((row) => row.type === 'header')
      .find((row) => row.key === `project:${project.id}`)
    expect(header).toBeDefined()
    expect(header?.repo).toBe(present ? repo : undefined)
    expect(header?.hostRepos?.get('local')).not.toBe(childRepo)
  }
})

it('preserves genuine hostless pending fallback and rederives an empty/late catalog with admitted fallback notices', () => {
  const pending = { creationId: 'hostless', repoId: repo.id }
  const noModel = prepareSections([repo], [], { pendingCreations: [pending] }).render(new Set())
  expect(
    noModel.filter((row) => row.type === 'header').map((row) => [row.key, row.repo, row.hostRepos])
  ).toEqual([[`repo:${repo.id}`, repo, undefined]])
  expect(
    sectionHosts(noModel)
      .filter((row) => row.type === 'pending-creation')
      .map((row) => row.repo)
  ).toEqual([repo])
  const empty: ProjectSectionModel = { projects: [], projectHostSetups: [] }
  for (const model of [empty, groupingFor([repo])]) {
    const raw = prepareSections([repo], [worktree], {
      projectGrouping: model,
      importedWorktreesByRepo: new Map([[repo.id, { repo, hiddenWorktrees: [] }]])
    }).render(new Set())
    const header = raw.find((row) => row.type === 'header')!
    expect(header.repo).toBe(repo)
    expect(header.key).toBe(model === empty ? `repo:${repo.id}` : `project:${project.id}`)
    expect(raw.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
  }
})

it('uses the built missing-Repo pending row default host without fabricating a remote target', () => {
  const model = groupingFor([repo, remoteRepo])
  const raw = prepareSections([repo], [worktree], {
    projectGrouping: model,
    pendingCreations: [
      { creationId: 'missing-remote', repoId: remoteRepo.id, hostId: 'ssh:gpu-vm' }
    ]
  }).render(new Set())
  expect(raw.filter((row) => row.type === 'pending-creation').map((row) => row.repo)).toEqual([
    undefined
  ])
  expect(raw.find((row) => row.type === 'header')!.hostRepos).toBeUndefined()
  expect(
    sectionHosts(raw)
      .filter((row) => row.type === 'header')
      .map((row) => row.repo)
  ).toEqual([repo])
})

it.each(['registrations', 'worktrees', 'keys', 'hosts', 'unrelated'] as const)(
  'bounds real expanded/collapsed section operations with independent %s growth at N and 10N',
  (dimension) => {
    for (const n of [100, 1000]) {
      const r =
        dimension === 'registrations' ? n : dimension === 'keys' || dimension === 'hosts' ? 1000 : 2
      const w = dimension === 'worktrees' ? n : dimension === 'hosts' ? 1000 : 2
      const k = dimension === 'keys' ? n : dimension === 'hosts' ? 1000 : 2
      const h = dimension === 'hosts' ? n : 2
      let measuringSection = false
      let candidateVisits = 0
      let upstreamCandidateVisits = 0
      const entries: Repo[] = Array.from({ length: r }, (_, i) => {
        const hostId: ExecutionHostId = i % h === 0 ? 'local' : `runtime:perf-${i % h}`
        const entry: Repo = { ...repo, id: `perf-${i}`, path: `/perf/${i}` }
        Object.defineProperty(entry, 'executionHostId', {
          enumerable: true,
          get: () => {
            if (measuringSection) {
              candidateVisits++
            } else {
              upstreamCandidateVisits++
            }
            return hostId
          }
        })
        return entry
      })
      const unrelated: Repo[] = Array.from(
        { length: dimension === 'unrelated' ? n : 0 },
        (_, i) => ({
          ...repo,
          id: `unrelated-${i}`,
          path: `/unrelated/${i}`
        })
      )
      const worktrees = Array.from({ length: w }, (_, i) => ({
        ...worktree,
        id: `perf-wt-${i}`,
        repoId: entries[i % r].id,
        hostId: getRepoExecutionHostId(entries[i % r])
      }))
      const options: HostSectionOption[] = Array.from({ length: h }, (_, i) => ({
        id: i === 0 ? 'local' : `runtime:perf-${i}`,
        kind: i === 0 ? 'local' : 'runtime',
        label: `Host ${i}`,
        detail: '',
        health: 'available'
      }))
      const imported = new Map([[entries[1].id, { repo: entries[1], hiddenWorktrees: [] }]])
      const external = new Map([[entries[1].id, { repo: entries[1], inboxWorktrees: [] }]])
      const plan = prepareSections([...entries, ...unrelated], worktrees, {
        projectGrouping: groupingFor(entries),
        placeholderRepoIds: new Set(entries.slice(0, k).map((entry) => entry.id)),
        importedWorktreesByRepo: imported,
        newExternalWorktreesInboxByRepo: external,
        pendingCreations: ['first', 'second'].map((creationId) => ({
          creationId,
          repoId: entries[1].id,
          hostId: getRepoExecutionHostId(entries[1])
        }))
      })
      for (const collapsed of [false, true]) {
        candidateVisits = 0
        upstreamCandidateVisits = 0
        const importedGet = vi.spyOn(imported, 'get')
        const externalGet = vi.spyOn(external, 'get')
        const originalGet = Map.prototype.get
        const qualifiedByMap = new Map<object, string[]>()
        const pendingMaps = new Set<object>()
        let qualifiedReads = 0
        let upstreamQualifiedReads = 0
        let sectionMapReads = 0
        const append = sectionEmitter.appendOrderedGroups
        const appendSpy = vi
          .spyOn(sectionEmitter, 'appendOrderedGroups')
          .mockImplementation((...args) => {
            measuringSection = true
            try {
              return append(...args)
            } finally {
              measuringSection = false
            }
          })
        const get = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
          this: Map<unknown, unknown>,
          key: unknown
        ) {
          const value = originalGet.call(this, key)
          if (measuringSection) {
            sectionMapReads++
          }
          if (typeof key === 'string' && key.includes('\0')) {
            if (!measuringSection) {
              upstreamQualifiedReads++
              return value
            }
            qualifiedReads++
            const calls: string[] = originalGet.call(qualifiedByMap, this) ?? []
            calls.push(key)
            qualifiedByMap.set(this, calls)
            if (Array.isArray(value) && value[0]?.creationId === 'first') {
              pendingMaps.add(this)
            }
          }
          return value
        })
        let rows: HostSectionRow[]
        try {
          rows = sectionHosts(
            plan.render(new Set(collapsed ? [`project:${project.id}`] : [])),
            options
          )
          expect(importedGet).toHaveBeenCalledTimes(0)
          expect(externalGet).toHaveBeenCalledTimes(0)
          expect(pendingMaps.size).toBe(1)
          const [pendingMap] = pendingMaps
          const probes = originalGet.call(qualifiedByMap, pendingMap) ?? []
          expect(probes).toHaveLength(r)
          expect(new Set(probes).size).toBe(r)
          expect(qualifiedReads).toBeGreaterThanOrEqual(r)
          expect(qualifiedReads).toBeLessThanOrEqual(12 * (r + w + k + h + 2))
          expect(sectionMapReads).toBeLessThanOrEqual(20 * (r + w + k + h + 2))
          expect(candidateVisits).toBeGreaterThan(r)
          expect(candidateVisits).toBeLessThanOrEqual(40 * (r + w + k + h + 2))
          process.stdout.write(
            `PG7 operations ${JSON.stringify({
              dimension,
              n,
              collapsed,
              r,
              w,
              k,
              h,
              p: 2,
              qualifiedReads,
              sectionMapReads,
              candidateVisits,
              pendingProbes: probes.length,
              importedProbes: importedGet.mock.calls.length,
              externalProbes: externalGet.mock.calls.length,
              upstreamQualifiedReads,
              upstreamCandidateVisits
            })}\n`
          )
        } finally {
          appendSpy.mockRestore()
          get.mockRestore()
          importedGet.mockRestore()
          externalGet.mockRestore()
        }
        const headers = rows.filter((row) => row.type === 'header')
        expect(headers).toHaveLength(h)
        expect(headers.map((row) => row.repo)).toEqual(entries.slice(0, h))
        expect(headers.every((row) => row.key === `project:${project.id}`)).toBe(true)
        expect(
          rows.filter((row) => row.type === 'pending-creation').map((row) => row.creationId)
        ).toEqual(collapsed ? [] : ['first', 'second'])
      }
    }
  }
)

it.each(['notices', 'pending', 'sections'] as const)(
  'bounds actual assurance and shared section emission for independent %s N/10N',
  (dimension) => {
    for (const n of [100, 1000]) {
      const count = dimension === 'sections' ? 1000 : n
      const entries = Array.from({ length: 1000 }, (_, i) => ({
        ...repo,
        id: `pg8-${i}`,
        path: `/repos/${i}`
      }))
      const model = groupingFor(entries)
      if (dimension === 'sections') {
        model.projects = entries.slice(0, n).map((_, i) => ({ ...project, id: `project-${i}` }))
        model.projectHostSetups = model.projectHostSetups.map((setup, i) => ({
          ...setup,
          projectId: `project-${i % n}`
        }))
      }
      const imported = new Map(
        entries
          .slice(0, dimension === 'pending' ? 1 : count)
          .map((entry) => [entry.id, { repo: entry, hiddenWorktrees: [] }])
      )
      const pending = Array.from({ length: dimension === 'notices' ? 1 : count }, (_, i) => ({
        creationId: `pg8-create-${i}`,
        repoId: entries[i].id,
        hostId: 'local' as const
      }))
      const originalGet = Map.prototype.get
      let operations = 0
      const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown
      ) {
        operations++
        return originalGet.call(this, key)
      })
      let rows: ReturnType<ReturnType<typeof prepareSections>['render']>
      try {
        rows = prepareSections(entries, [], {
          projectGrouping: model,
          importedWorktreesByRepo: imported,
          pendingCreations: pending
        }).render(new Set())
      } finally {
        probe.mockRestore()
      }
      expect(
        rows.filter((row) => row.type === 'imported-worktrees-card').map((row) => row.repo)
      ).toEqual(
        dimension === 'sections'
          ? Array.from({ length: n }, (_, i) =>
              Array.from({ length: 1000 / n }, (_, j) => entries[i + j * n])
            ).flat()
          : [...imported.values()].map((candidate) => candidate.repo)
      )
      expect(
        rows
          .filter((row) => row.type === 'pending-creation')
          .map((row) => row.creationId)
          .sort()
      ).toEqual(pending.map((creation) => creation.creationId).sort())
      expect(rows.filter((row) => row.type === 'header')).toHaveLength(
        dimension === 'sections' ? n : 1
      )
      expect(operations).toBeGreaterThan(count)
      expect(operations).toBeLessThan(
        70 * (1000 + imported.size + pending.length + (dimension === 'sections' ? n : 1))
      )
      process.stdout.write(
        `PG8 assurance operations ${JSON.stringify({ dimension, n, r: 1000, notices: imported.size, pending: pending.length, sections: dimension === 'sections' ? n : 1, operations })}\n`
      )
    }
  }
)

it('retains both unknown twins and qualified pending assignments through null/empty/unrelated/late models and nonrepo modes', () => {
  const local = { ...repo, executionHostId: 'local' as const }
  const remote = { ...remoteRepo, id: local.id }
  const entries = [local, remote]
  const unknowns = [undefined, { projects: [], projectHostSetups: [] }, groupingFor([otherRepo])]
  for (const model of [...unknowns, groupingFor(entries)]) {
    const imported = new Map(
      entries.map((entry) => [
        `${getRepoExecutionHostId(entry)}\0${entry.id}`,
        { repo: entry, hiddenWorktrees: [] }
      ])
    )
    const pending = entries.map((entry, i) => ({
      creationId: `unknown-${i}`,
      repoId: entry.id,
      hostId: getRepoExecutionHostId(entry)
    }))
    const plan = prepareSections(entries, [], {
      projectGrouping: model,
      importedWorktreesByRepo: imported,
      pendingCreations: pending
    })
    const rows = plan.render(new Set())
    expect(
      rows.filter((row) => row.type === 'imported-worktrees-card').map((row) => row.repo)
    ).toEqual(entries)
    expect(rows.filter((row) => row.type === 'pending-creation').map((row) => row.repo)).toEqual(
      entries
    )
    expect(
      new Set(rows.filter((row) => row.type === 'imported-worktrees-card').map((row) => row.key))
        .size
    ).toBe(2)
    const header = rows.find((row) => row.type === 'header')!
    expect(header.hostRepos?.get('local')).toBe(local)
    expect(header.hostRepos?.get('ssh:gpu-vm')).toBe(remote)
    for (const groupBy of ['none', 'pr-status', 'workspace-status'] as const) {
      const nonrepo = prepareSections(entries, [], { groupBy, pendingCreations: pending }).render(
        new Set()
      )
      expect(
        nonrepo.filter((row) => row.type === 'pending-creation').map((row) => row.repo)
      ).toEqual(entries)
    }
  }
})

it('keeps the local row label qualified when only its SSH registration establishes ambiguity', () => {
  const local = { ...repo, id: 'same', executionHostId: 'local' as const }
  const ssh = { ...remoteRepo, id: local.id }
  const rows = prepareSections([local, ssh], [{ ...worktree, repoId: local.id, hostId: 'local' }], {
    projectGrouping: groupingFor([local, ssh]),
    hostLabelById: new Map(hosts.map((host) => [host.id, host.label]))
  }).render(new Set())
  expect(
    rows.filter((row) => row.type === 'item').map((row) => [row.repo, row.hostContextLabel])
  ).toEqual([[local, 'Local Mac']])
  expect(sectionHosts(rows).filter((row) => row.type === 'host-header')).toEqual([])
})

it('retains own display and original beta-first context when host-mode ordering selects a known foreign raw anchor', () => {
  const local = { ...repo, id: 'same', executionHostId: 'local' as const }
  const sshAlpha = {
    ...local,
    executionHostId: 'ssh:gpu-vm' as const,
    path: '/ssh/alpha',
    badgeColor: '#123456'
  }
  const sshBeta = { ...sshAlpha, id: 'beta', path: '/ssh/beta', badgeColor: '#654321' }
  const entries = [local, sshAlpha, sshBeta]
  const plan = prepareSections(
    entries,
    [
      { ...worktree, id: 'beta-main', repoId: 'beta', hostId: 'ssh:gpu-vm' },
      { ...worktree, id: 'alpha-main', repoId: 'same', hostId: 'ssh:gpu-vm' }
    ],
    {
      repoMap: new Map([
        [local.id, local],
        [sshBeta.id, sshBeta]
      ]),
      repoOrder: new Map([
        [local.id, 0],
        [sshBeta.id, 1]
      ]),
      projectGrouping: groupingFor(entries, 'host')
    }
  )
  const header = plan
    .render(new Set())
    .find(
      (row) =>
        row.type === 'header' &&
        row.projectScope?.registrations.some((setup) => setup.hostId === 'ssh:gpu-vm')
    )
  expect(header?.type).toBe('header')
  if (header?.type !== 'header') {
    throw new Error('Missing real SSH section')
  }
  expect(header.repo).toBeUndefined()
  expect(header.displayRepo).toBe(sshAlpha)
  expect(header.contextRepo).toBe(sshBeta)
  expect(header.projectScope?.context).toMatchObject({ repoId: 'beta', hostId: 'ssh:gpu-vm' })
  expect(header.projectScope?.registrations.map((setup) => setup.repoId)).toEqual(['same', 'beta'])
})
