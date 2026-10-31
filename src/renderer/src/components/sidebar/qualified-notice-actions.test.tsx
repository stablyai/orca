// @vitest-environment happy-dom
import {
  fetchWorktreesFixture,
  local,
  remote,
  detected,
  envelope
} from './qualified-notice-actions-test-fixtures'
import { act } from 'react'

import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import type { AppState } from '@/store/types'
import { TooltipProvider } from '../ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  buildImportedWorktreesCardRow,
  buildNewExternalWorktreesInboxRow
} from '../../../../shared/sidebar-list/row-builders'
import { repo } from './worktree-list-groups-test-fixtures'
import { buildImportedWorktreesCardCandidates } from './imported-worktrees-card-candidates'
import { buildNewExternalWorktreesInboxCandidates } from './new-external-worktrees-inbox-candidates'
import {
  partitionDetectedWorktreesByHost,
  resolveWorktreeVisibilityHostTarget
} from './worktree-visibility-host-target'
import { useSidebarExternalWorktreeCards } from './worktree-list/listing/use-external-worktree-cards'
import { SidebarWorktreeListDialogs } from './worktree-list/rows/ProjectGroupDialogs'
import { useProjectGroupDialogs } from './worktree-list/rows/use-project-group-dialogs'
import {
  renderNewExternalWorktreesInboxVirtualRow,
  renderImportedWorktreesVirtualRow
} from './worktree-list/rows/notice-rows'
it('partitions full current ownership once, retaining opaque envelope and runtime-owned SSH rows for both notices and Review', () => {
  const ssh = { ...local, executionHostId: 'ssh:box' as const }
  const rows = [
    detected('/legacy'),
    detected('/ssh', { hostId: 'ssh:box' }),
    detected('/transport', { hostId: 'ssh:box', runtimeOwnerEnvironmentId: 'server' })
  ]
  const result = envelope(rows)
  const allRepos = [local, remote, ssh]
  const source = { [local.id]: result }
  const partitions = partitionDetectedWorktreesByHost(allRepos, source)
  expect(partitions.get(getRepoHostIdentity(local))?.worktrees).toEqual([rows[0]])
  expect(partitions.get(getRepoHostIdentity(ssh))?.worktrees).toEqual([rows[1]])
  expect(partitions.get(getRepoHostIdentity(remote))?.worktrees[0]).toBe(rows[2])
  expect(partitions.get(getRepoHostIdentity(remote))?.source).toBe(result.source)
  const candidates = buildImportedWorktreesCardCandidates({
    repos: [remote],
    allRepos,
    detectedWorktreesByRepo: source,
    filterRepoIds: [`runtime:server\0${local.id}`]
  })
  expect([...candidates.keys()]).toEqual([getRepoHostIdentity(remote)])
  expect(candidates.get(getRepoHostIdentity(remote))?.hiddenWorktrees).toEqual([rows[2]])
  const inboxRepos = allRepos.map((entry) => ({
    ...entry,
    externalWorktreeVisibilityPromptDismissedAt: 1
  }))
  const inbox = buildNewExternalWorktreesInboxCandidates({
    repos: inboxRepos,
    detectedWorktreesByRepo: source
  })
  expect(
    [...inbox.values()].map((candidate) => candidate.inboxWorktrees.map((row) => row.path))
  ).toEqual([['/legacy'], ['/transport'], ['/ssh']])
  expect(
    resolveWorktreeVisibilityHostTarget(
      { repos: allRepos, settings: getDefaultSettings('/tmp'), detectedWorktreesByRepo: source },
      local.id,
      'runtime:server'
    ).detected?.worktrees
  ).toEqual([rows[2]])
  // Two Repo records on the SAME remote owner are not a sole-entry ownership proof.
  expect(
    partitionDetectedWorktreesByHost([remote, { ...remote }], source).get(
      getRepoHostIdentity(remote)
    )?.worktrees
  ).toEqual([rows[2]])
  expect(
    partitionDetectedWorktreesByHost([remote], { [repo.id]: envelope([rows[0]]) }).get(
      getRepoHostIdentity(remote)
    )?.worktrees
  ).toEqual([rows[0]])
})

it('routes a rendered concrete Show through mounted action/rollback adapters and rereads exact KeepHidden state after refresh', async () => {
  const updateRepo = vi.fn<AppState['updateRepo']>(async () => true)
  const { fetchWorktrees: fetchWorktreesService, ordinary: fetchWorktrees } =
    fetchWorktreesFixture()
  useAppStore.setState({
    repos: [local, remote],
    settings: getDefaultSettings('/tmp'),
    updateRepo,
    fetchWorktrees: fetchWorktreesService
  })
  let cards!: ReturnType<typeof useSidebarExternalWorktreeCards>
  let currentDetected = {
    [repo.id]: envelope([
      detected('/server/hidden', { runtimeOwnerEnvironmentId: 'server' }),
      detected('/local/hidden')
    ])
  }
  function Harness() {
    const repos = useAppStore((state) => state.repos)
    cards = useSidebarExternalWorktreeCards({
      repos,
      visibleReposForRows: repos,
      detectedWorktreesByRepo: currentDetected,
      filterRepoIds: []
    })
    return [...cards.importedWorktreesByRepo.values()].map((candidate, index) => {
      const row = buildImportedWorktreesCardRow(candidate, 'repo-group')
      return (
        <div key={row.key} data-owner={getRepoExecutionHostId(candidate.repo)}>
          {renderImportedWorktreesVirtualRow({
            row,
            vItem: { index, key: row.key, start: 0, end: 20, size: 20, lane: 0 },
            measureVirtualRowElement: () => {},
            actionState: cards.importedWorktreeCardActionState.get(
              getRepoHostIdentity(candidate.repo)
            ),
            onShow: cards.handleShowImportedWorktrees,
            onKeepHidden: cards.handleKeepImportedWorktreesHidden
          })}
        </div>
      )
    })
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    act(() =>
      root.render(
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      )
    )
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-owner="runtime:server"] button[aria-expanded="false"]'
        )!
        .click()
    )
    const show = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-owner="runtime:server"] button')
    ].find((button) => button.textContent?.includes('Show'))!
    expect(show).toBeDefined()
    await act(async () => {
      show.click()
    })
    expect(updateRepo.mock.calls).toEqual([
      [repo.id, { externalWorktreeVisibility: 'show' }, { hostId: 'runtime:server' }],
      [repo.id, { externalWorktreeVisibility: 'hide' }, { hostId: 'runtime:server' }]
    ])
    expect(fetchWorktrees.mock.calls).toEqual([
      [repo.id, { requireAuthoritative: true, executionHostId: 'runtime:server' }]
    ])
    expect(cards.importedWorktreeCardActionState.has(getRepoHostIdentity(local))).toBe(false)
    expect(
      cards.importedWorktreeCardActionState.get(getRepoHostIdentity(remote))?.error
    ).toBeTruthy()
    updateRepo.mockClear()
    updateRepo.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await act(async () => {
      await cards.handleShowImportedWorktrees(remote)
    })
    expect(
      cards.importedWorktreeCardActionState.get(getRepoHostIdentity(remote))?.forceVisible
    ).toBe(true)
    expect(cards.importedWorktreeCardActionState.has(getRepoHostIdentity(local))).toBe(false)
    fetchWorktrees.mockResolvedValueOnce(true)
    await act(async () => {
      await cards.handleShowImportedWorktrees(remote)
    })
    expect(cards.importedWorktreeCardActionState.has(getRepoHostIdentity(remote))).toBe(false)
    updateRepo.mockClear()
    currentDetected = { [repo.id]: envelope([], false) }
    act(() => useAppStore.setState({ detectedWorktreesByRepo: currentDetected }))
    await act(async () => {
      await cards.handleKeepImportedWorktreesHidden(remote)
    })
    expect(updateRepo).not.toHaveBeenCalled()
    expect(
      cards.importedWorktreeCardActionState.get(getRepoHostIdentity(remote))?.error
    ).toBeTruthy()
    fetchWorktrees.mockImplementation(async () => {
      useAppStore.setState({
        repos: [{ ...remote, externalWorktreeInboxBaselinePaths: ['/fresh-baseline'] }, local],
        detectedWorktreesByRepo: {
          [repo.id]: envelope([
            detected('/fresh-server', { runtimeOwnerEnvironmentId: 'server' }),
            detected('/foreign-local')
          ])
        }
      })
      return true
    })
    await act(async () => {
      await cards.handleKeepImportedWorktreesHidden(remote)
    })
    expect(updateRepo).toHaveBeenCalledWith(
      repo.id,
      expect.objectContaining({
        externalWorktreeInboxBaselinePaths: ['/fresh-baseline', '/fresh-server']
      }),
      { hostId: 'runtime:server' }
    )
    updateRepo.mockClear()
    act(() => useAppStore.setState({ repos: [local], detectedWorktreesByRepo: currentDetected }))
    await act(async () => {
      await cards.handleKeepImportedWorktreesHidden(remote)
    })
    expect(updateRepo).not.toHaveBeenCalled()
    expect(
      cards.importedWorktreeCardActionState.get(getRepoHostIdentity(remote))?.error
    ).toBeTruthy()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

it.each(['repos', 'detected', 'hosts'] as const)(
  'bounds mounted notice preparation with independent %s N/10N',
  (dimension) => {
    for (const n of [100, 1000]) {
      let repoReads = 0
      let detectedReads = 0
      const r = dimension === 'repos' ? n : 1000
      const d = dimension === 'detected' ? n : 1000
      const h = dimension === 'hosts' ? n : 1
      const repos = Array.from({ length: r }, (_, i) => ({
        ...local,
        get id() {
          repoReads++
          return `notice-${i}`
        },
        executionHostId: `runtime:host-${i % h}` as const
      }))
      const rows = Array.from({ length: d }, (_, i) => ({
        ...detected(`/detected/${i}`),
        get runtimeOwnerEnvironmentId() {
          detectedReads++
          return 'host-0'
        }
      }))
      const source = { 'notice-0': { ...envelope(rows), repoId: 'notice-0' } }
      let cards!: ReturnType<typeof useSidebarExternalWorktreeCards>
      useAppStore.setState({ settings: getDefaultSettings('/tmp') })
      function Harness() {
        cards = useSidebarExternalWorktreeCards({
          repos,
          visibleReposForRows: repos,
          detectedWorktreesByRepo: source,
          filterRepoIds: []
        })
        return null
      }
      const container = document.createElement('div')
      const root = createRoot(container)
      try {
        act(() => root.render(<Harness />))
        expect(
          [...cards.importedWorktreesByRepo.values()].flatMap(
            (candidate) => candidate.hiddenWorktrees
          )
        ).toEqual(rows)
        expect(repoReads).toBeGreaterThanOrEqual(r)
        expect(repoReads).toBeLessThan(30 * r + 10)
        expect(detectedReads).toBeGreaterThanOrEqual(d)
        expect(detectedReads).toBeLessThanOrEqual(3 * d)
        process.stdout.write(
          `PG8 notice operations ${JSON.stringify({ dimension, n, r, d, h, repoReads, detectedReads })}\n`
        )
      } finally {
        act(() => root.unmount())
      }
    }
  }
)

it('retains exact inbox dialog, failure and recovery identity across same-ID twins and removes an abandoned target without retargeting', async () => {
  const targets = [local, remote].map((target) => ({
    ...target,
    externalWorktreeVisibilityPromptDismissedAt: 1
  }))
  const updateRepo = vi.fn<AppState['updateRepo']>(async () => false)
  const { fetchWorktrees: fetchWorktreesService } = fetchWorktreesFixture()
  const recovery = vi.fn()
  let cards!: ReturnType<typeof useSidebarExternalWorktreeCards>
  const source = {
    [repo.id]: envelope([
      detected('/server/new', { runtimeOwnerEnvironmentId: 'server' }),
      detected('/local/new')
    ])
  }
  useAppStore.setState({
    repos: targets,
    settings: getDefaultSettings('/tmp'),
    updateRepo,
    fetchWorktrees: fetchWorktreesService
  })
  function Harness() {
    const repos = useAppStore((state) => state.repos)
    cards = useSidebarExternalWorktreeCards({
      repos,
      visibleReposForRows: repos,
      detectedWorktreesByRepo: source,
      filterRepoIds: []
    })
    const dialogs = useProjectGroupDialogs({
      repos,
      repoMap: new Map(repos.map((target) => [target.id, target])),
      projectGroups: []
    })
    return (
      <TooltipProvider>
        {[...cards.newExternalWorktreesInboxByRepo.values()].map((candidate, index) => {
          const row = buildNewExternalWorktreesInboxRow(candidate)
          return (
            <div key={row.key} data-owner={getRepoExecutionHostId(candidate.repo)}>
              {renderNewExternalWorktreesInboxVirtualRow({
                row,
                vItem: { index, key: row.key, start: 0, end: 20, size: 20, lane: 0 },
                measureVirtualRowElement: () => {},
                actionState: cards.newExternalWorktreeInboxActionState.get(
                  getRepoHostIdentity(candidate.repo)
                ),
                onReview: recovery,
                onSuppress: cards.handleOpenSuppressExternalWorktreeInbox
              })}
            </div>
          )
        })}
        <SidebarWorktreeListDialogs
          dialogs={dialogs}
          repos={repos}
          settings={useAppStore.getState().settings}
          suppressExternalWorktreeInboxRepoId={cards.suppressExternalWorktreeInboxRepoId}
          setSuppressExternalWorktreeInboxRepoId={cards.setSuppressExternalWorktreeInboxRepoId}
          newExternalWorktreeInboxActionState={cards.newExternalWorktreeInboxActionState}
          onConfirmSuppressExternalWorktreeInbox={cards.handleConfirmSuppressExternalWorktreeInbox}
          onOpenWorktreeVisibility={recovery}
        />
      </TooltipProvider>
    )
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const clickNamed = async (name: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === name
    )!
    expect(button).toBeDefined()
    await act(async () => {
      button.click()
    })
  }
  const openRemote = () =>
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-owner="runtime:server"] button[aria-label^="Hide external"]'
        )!
        .click()
    )
  try {
    act(() => root.render(<Harness />))
    openRemote()
    expect(cards.suppressExternalWorktreeInboxRepoId).toBe(targets[1])
    await clickNamed('Hide external worktrees')
    expect(updateRepo).toHaveBeenLastCalledWith(
      repo.id,
      expect.objectContaining({ externalWorktreeInboxBaselinePaths: ['/server/new'] }),
      { hostId: 'runtime:server' }
    )
    expect(
      cards.newExternalWorktreeInboxActionState.get(getRepoHostIdentity(remote))?.error
    ).toBeTruthy()
    expect(cards.newExternalWorktreeInboxActionState.has(getRepoHostIdentity(local))).toBe(false)
    expect(cards.suppressExternalWorktreeInboxRepoId).toBe(targets[1])
    const latest = { ...targets[1], path: '/server/current' }
    act(() => useAppStore.setState({ repos: [targets[0], latest] }))
    await clickNamed('Open Non-Orca worktrees settings')
    expect(recovery).toHaveBeenLastCalledWith(latest)
    expect(cards.suppressExternalWorktreeInboxRepoId).toBeNull()
    openRemote()
    updateRepo.mockResolvedValue(true)
    await clickNamed('Hide external worktrees')
    expect(cards.suppressExternalWorktreeInboxRepoId).toBeNull()
    expect(cards.newExternalWorktreeInboxActionState.size).toBe(0)
    openRemote()
    act(() => useAppStore.setState({ repos: [targets[0]] }))
    updateRepo.mockClear()
    await clickNamed('Hide external worktrees')
    expect(updateRepo).not.toHaveBeenCalled()
    expect(cards.suppressExternalWorktreeInboxRepoId).toBeNull()
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})

// Geometry/platform services only; collection, viewport dispatch, menus and controllers remain production.
