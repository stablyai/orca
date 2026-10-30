// @vitest-environment happy-dom
import * as optionRanker from './palette-filter-option-list'
import * as projectEdits from '../../../../shared/project-repo-filter-selection'
import { useState } from 'react'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { worktree as worktreeBase } from '../sidebar/worktree-list-groups-test-fixtures'
import { buildPaletteFilterModel } from './palette-filter-options'
import {
  buildPaletteFilterPredicate,
  getPaletteProjectSelection,
  togglePaletteFilterValue,
  addPaletteFilterValues,
  type PaletteFilterState
} from './palette-filter'
import PaletteFilterChips from './PaletteFilterChips'
import PaletteFilterMenu from './PaletteFilterMenu'
import { TooltipProvider } from '../ui/tooltip'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)
const first: Repo = {
  id: 'a',
  path: '/a',
  displayName: 'Harbor',
  badgeColor: '',
  addedAt: 0,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/org/app',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/org/app'
  }
}
const second = { ...first, id: 'b', path: '/b', executionHostId: 'runtime:server' as const }
const notes = {
  ...first,
  id: 'notes',
  path: '/notes',
  displayName: 'Notes',
  gitRemoteIdentity: null
}
const repos = [first, second, notes]
const projection = projectHostSetupProjectionFromRepos(repos)
const worktrees = repos.flatMap((repo, index) =>
  Array.from({ length: index === 0 ? 3 : index === 1 ? 2 : 1 }, (_, i) => ({
    ...worktreeBase,
    id: `${repo.id}-${i}`,
    repoId: repo.id,
    hostId: repo.executionHostId ?? 'local',
    path: `${repo.path}/workspace-${i}`,
    displayName: repo.displayName
  }))
)
const model = buildPaletteFilterModel({
  repos,
  worktrees: [...worktrees, worktrees[0]],
  hostOptions: [],
  projects: projection.projects,
  projectHostSetups: projection.setups
})
const harbor = model.repositories.find((entry) => entry.label === 'Harbor')!.id

it('joins logical option complete/remove/select-all to exact selected workspace outputs without rewriting unresolved intent', () => {
  expect(model.repositories.map((entry) => [entry.label, entry.count])).toEqual([
    ['Harbor', 5],
    ['Notes', 1]
  ])
  let filter: PaletteFilterState = { hostIds: [], repoIds: ['local\0a', 'offline'] }
  const selected = getPaletteProjectSelection(model, filter.repoIds)
  expect(selected.partial.has(harbor)).toBe(true)
  expect(selected.unresolved).toEqual(['offline'])
  filter = togglePaletteFilterValue(filter, 'repository', harbor, model)
  expect(filter.repoIds).toContain('offline')
  expect(
    worktrees.filter(buildPaletteFilterPredicate(filter, model)!.matchesWorktree)
  ).toHaveLength(5)
  expect(filter.repoIds).not.toContain(harbor)
  filter = togglePaletteFilterValue(filter, 'repository', harbor, model)
  expect(filter.repoIds).toEqual(['offline'])
  filter = addPaletteFilterValues(
    filter,
    'repository',
    model.repositories.map((option) => option.id),
    model
  )
  expect(
    worktrees.filter(buildPaletteFilterPredicate(filter, model)!.matchesWorktree)
  ).toHaveLength(6)
  const raw = { hostIds: [], repoIds: ['a', 'runtime:server\0a'] }
  expect(
    buildPaletteFilterPredicate(raw, model)!.matchesWorktree({ repoId: 'a', hostId: 'local' })
  ).toBe(true)
})

it('renders grouped partial chips and retains Clear at zero/one option; removing a chip uses the shared member intent', async () => {
  let current: PaletteFilterState
  function Harness() {
    const [filter, setFilter] = useState<PaletteFilterState>({
      hostIds: [],
      repoIds: ['local\0a', 'offline']
    })
    current = filter
    return (
      <TooltipProvider>
        <PaletteFilterMenu
          model={model}
          filter={filter}
          onFilterChange={setFilter}
          onRequestInputFocus={() => {}}
          portalContainer={null}
        />
        <PaletteFilterChips model={model} filter={filter} onFilterChange={setFilter} />
      </TooltipProvider>
    )
  }
  render(<Harness />)
  const user = userEvent.setup()
  expect(screen.getByText(/Harbor · Partial/)).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /Remove filter Harbor/ }))
  expect(current!.repoIds).toEqual(['offline'])
  await user.click(screen.getByRole('button', { name: 'Clear all' }))
  expect(current!.repoIds).toEqual([])
  cleanup()
  for (const repositories of [[], model.repositories.slice(0, 1)]) {
    render(
      <PaletteFilterMenu
        model={{ ...model, repositories }}
        filter={{ hostIds: [], repoIds: ['offline'] }}
        onFilterChange={() => {}}
        onRequestInputFocus={() => {}}
        portalContainer={null}
      />
    )
    expect(screen.getByRole('button', { name: 'Filter results' })).toBeTruthy()
    cleanup()
  }
})

it('dispatches the actual menu search/complete/select-all/Clear to the current predicate and retains saved meaning across modes and overrides', async () => {
  let current: PaletteFilterState = { hostIds: [], repoIds: ['local\0a', 'offline'] }
  function Harness() {
    const [filter, setFilter] = useState(current)
    current = filter
    const predicate = buildPaletteFilterPredicate(filter, model)
    return (
      <TooltipProvider>
        <PaletteFilterMenu
          model={model}
          filter={filter}
          onFilterChange={setFilter}
          onRequestInputFocus={() => {}}
          portalContainer={null}
        />
        <output>
          {worktrees
            .filter((row) => !predicate || predicate.matchesWorktree(row))
            .map((row) => row.id)
            .join(',')}
        </output>
      </TooltipProvider>
    )
  }
  render(<Harness />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Filter results' }))
  await user.type(screen.getByRole('textbox', { name: 'Filter projects...' }), 'Harbor{Enter}')
  expect(document.querySelector('output')!.textContent).toBe('a-0,a-1,a-2,b-0,b-1')
  expect(current.repoIds).toContain('offline')
  await user.clear(screen.getByRole('textbox', { name: 'Filter projects...' }))
  await user.click(screen.getByRole('button', { name: 'Select all matching (1)' }))
  expect(document.querySelector('output')!.textContent).toBe('a-0,a-1,a-2,b-0,b-1,notes-0')
  await user.type(
    screen.getByRole('textbox', { name: 'Filter projects...' }),
    'no matching project'
  )
  await user.click(screen.getByRole('button', { name: 'Clear projects' }))
  expect(current.repoIds).toEqual([])
  cleanup()
  const twin = { ...second, id: first.id }
  const currentRepos = [first, twin, notes]
  const currentProjection = projectHostSetupProjectionFromRepos(currentRepos)
  const rows = worktrees.map((row) =>
    row.repoId === second.id ? { ...row, repoId: first.id } : row
  )
  const saved = ['local\0a', 'unresolved']
  for (const mode of ['repository', 'host', 'folder'] as const) {
    const grouped = buildPaletteFilterModel({
      repos: currentRepos,
      worktrees: [...rows, { ...rows[0], id: 'alias' }],
      hostOptions: [],
      projects: currentProjection.projects,
      projectHostSetups: currentProjection.setups,
      settings: { projectGroupingMode: mode }
    })
    expect(grouped.repositories.reduce((total, option) => total + option.count, 0)).toBe(6)
    expect(
      rows
        .filter(
          buildPaletteFilterPredicate({ hostIds: [], repoIds: saved }, grouped)!.matchesWorktree
        )
        .map((row) => row.id)
    ).toEqual(['a-0', 'a-1', 'a-2'])
    expect(
      rows.filter(
        buildPaletteFilterPredicate({ hostIds: [], repoIds: ['a'] }, grouped)!.matchesWorktree
      )
    ).toHaveLength(5)
    expect(saved).toEqual(['local\0a', 'unresolved'])
  }
  const overridden = buildPaletteFilterModel({
    repos: currentRepos,
    worktrees: rows,
    hostOptions: [],
    projects: currentProjection.projects,
    projectHostSetups: currentProjection.setups,
    settings: {
      projectGroupingMode: 'repository',
      projectGroupingOverrides: { [currentProjection.projects[0].id]: 'folder' }
    }
  })
  expect(overridden.repositories.map((option) => option.count).sort()).toEqual([1, 2, 3])
  const offlineProject = {
    ...currentProjection.projects[0],
    id: 'offline-project',
    displayName: 'Offline'
  }
  const offline = buildPaletteFilterModel({
    repos: [],
    worktrees: [],
    hostOptions: [],
    projects: [offlineProject],
    projectHostSetups: [
      {
        ...currentProjection.setups[0],
        projectId: offlineProject.id,
        id: 'offline-setup',
        repoId: 'offline-source',
        setupState: 'not-set-up'
      }
    ]
  })
  expect(offline.repositories).toMatchObject([{ label: 'Offline', count: 0 }])
  const completed = addPaletteFilterValues(
    { hostIds: [], repoIds: ['unresolved'] },
    'repository',
    [offline.repositories[0].id],
    offline
  )
  expect(getPaletteProjectSelection(offline, completed.repoIds).full.size).toBe(1)
  expect(completed.repoIds).toContain('unresolved')
})

it.each([
  ['', 'a-0,a-1,a-2,b-0,b-1,notes-0', 2],
  ['Harbor', 'a-0,a-1,a-2,b-0,b-1', 1],
  ['Notes', 'a-0,a-1,a-2,notes-0', 1]
])('completes initial partial selection directly for query %s', async (query, expected, count) => {
  let current: PaletteFilterState = { hostIds: [], repoIds: ['local\0a', 'offline'] }
  function Harness() {
    const [filter, setFilter] = useState(current)
    current = filter
    const predicate = buildPaletteFilterPredicate(filter, model)
    return (
      <TooltipProvider>
        <PaletteFilterMenu
          model={model}
          filter={filter}
          onFilterChange={setFilter}
          onRequestInputFocus={() => {}}
          portalContainer={null}
        />
        <PaletteFilterChips model={model} filter={filter} onFilterChange={setFilter} />
        <output>
          {worktrees
            .filter((row) => !predicate || predicate.matchesWorktree(row))
            .map((row) => row.id)
            .join(',')}
        </output>
      </TooltipProvider>
    )
  }
  render(<Harness />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Filter results' }))
  if (query) {
    await user.type(screen.getByRole('textbox', { name: 'Filter projects...' }), query)
  }
  await user.click(screen.getByRole('button', { name: `Select all matching (${count})` }))
  expect(document.querySelector('output')!.textContent).toBe(expected)
  expect(current.repoIds).toContain('offline')
  expect(getPaletteProjectSelection(model, current.repoIds).partial.has(harbor)).toBe(
    query === 'Notes'
  )
  if (query !== 'Notes') {
    expect(screen.queryByText(/Harbor · Partial/)).toBeNull()
  }
})

it.each([100, 1000])(
  'counts actual menu completion ranking and one bulk member edit at %i options',
  async (n) => {
    const catalog = Array.from({ length: n }, (_, i) => ({
      ...first,
      id: `repo-${i}`,
      displayName: `Project ${i}`,
      path: `/local/${i}`,
      gitRemoteIdentity: {
        ...first.gitRemoteIdentity!,
        canonicalKey: `github.com/org/project-${i}`,
        remoteUrl: `https://github.com/org/project-${i}`
      }
    }))
    const allRepos = [
      ...catalog,
      ...catalog.map((repo) => ({
        ...repo,
        executionHostId: 'runtime:server' as const,
        path: `/remote/${repo.id}`
      }))
    ]
    const projection = projectHostSetupProjectionFromRepos(allRepos)
    const base = buildPaletteFilterModel({
      repos: allRepos,
      worktrees: [],
      hostOptions: [],
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    let reads = 0
    const model = {
      ...base,
      repositories: base.repositories.map(
        (option) =>
          new Proxy(option, {
            get(target, key, receiver) {
              if (key === 'searchText') {
                reads++
              }
              return Reflect.get(target, key, receiver)
            }
          })
      )
    }
    const actualRank = optionRanker.rankPaletteFilterOptions
    const passes: number[] = []
    const rankSpy = vi
      .spyOn(optionRanker, 'rankPaletteFilterOptions')
      .mockImplementation((args) => {
        const before = reads
        const result = actualRank(args)
        if (args.query) {
          passes.push(reads - before)
        }
        return result
      })
    const editSpy = vi.spyOn(projectEdits, 'editProjectFilter')
    let current: PaletteFilterState = { hostIds: [], repoIds: ['local\0repo-0', 'offline'] }
    function Harness() {
      const [filter, setFilter] = useState(current)
      current = filter
      return (
        <PaletteFilterMenu
          model={model}
          filter={filter}
          onFilterChange={setFilter}
          onRequestInputFocus={() => {}}
          portalContainer={null}
        />
      )
    }
    try {
      render(<Harness />)
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Filter results' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Filter projects...' }), {
        target: { value: 'Project' }
      })
      await user.click(screen.getByRole('button', { name: `Select all matching (${n})` }))
      expect(editSpy).toHaveBeenCalledTimes(1)
      expect(current.repoIds).toContain('offline')
      const predicate = buildPaletteFilterPredicate(current, model)!
      expect(
        allRepos.filter((repo) =>
          predicate.matchesWorktree({ repoId: repo.id, hostId: repo.executionHostId ?? 'local' })
        )
      ).toHaveLength(2 * n)
      expect(getPaletteProjectSelection(model, current.repoIds).full.size).toBe(n)
      expect(getPaletteProjectSelection(model, current.repoIds).partial.size).toBe(0)
      expect(passes.length).toBeGreaterThan(0)
      expect(passes.every((count) => count === n)).toBe(true)
      process.stdout.write(
        `PG9 palette operations ${JSON.stringify({ n, registrations: 2 * n, rankPasses: passes.length, searchReadsByPass: passes, bulkEdits: editSpy.mock.calls.length, matchedOwners: 2 * n })}\n`
      )
    } finally {
      cleanup()
      rankSpy.mockRestore()
      editSpy.mockRestore()
    }
  }
)
