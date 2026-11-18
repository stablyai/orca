import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { DetectedWorktree } from '../../../../../../shared/worktree/types'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import { keepImportedWorktreesHiddenCard } from '../../worktree-list/listing/imported-worktrees-card-actions'
import { importNewExternalWorktreeInboxPaths } from '../../worktree-list/listing/new-external-worktrees-inbox-actions'
import { openProjectDefaultCheckout } from './project-added-default-checkout'

const harness = vi.hoisted(() => ({
  state: null as AppState | null,
  activate: vi.fn(),
  persist: vi.fn()
}))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => harness.state! } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: harness.activate
}))
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/components/onboarding/onboarding-project-checklist', () => ({
  markOnboardingProjectAdded: vi.fn()
}))
vi.mock('@/store/projects/project-host-routing', () => ({
  getProjectSetupRuntimeTarget: () => ({ kind: 'local' })
}))

const repo: Repo = {
  id: 'project',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '',
  addedAt: 0,
  kind: 'git'
}
function checkout(path: string, extra: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: `project::${path}`,
    repoId: 'project',
    path,
    name: path,
    branch: 'topic',
    head: 'abc',
    isMainWorktree: path === '/repo',
    isArchived: false,
    lastActivityAt: 0,
    visible: true,
    ...extra
  } as DetectedWorktree
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(rows: DetectedWorktree[], repos: Repo[] = [repo], confirmationFails = false) {
  const persisted = new Map(repos.map((row) => [row.executionHostId ?? 'local', row]))
  harness.persist.mockImplementation(async ({ updates, hostId }) => {
    const owner = hostId ?? 'local'
    const next = { ...persisted.get(owner)!, ...updates }
    persisted.set(owner, next)
    return next
  })
  vi.stubGlobal('window', { api: { repos: { update: harness.persist } } })
  const store = createStore<AppState>()(
    (set, get) =>
      ({
        repos,
        projects: [],
        projectHostSetups: [],
        settings: {},
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        hideDefaultBranchWorkspace: true,
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        setHideDefaultBranchWorkspace: vi.fn(),
        setActiveRepo: vi.fn(),
        setProjectFilterIds: vi.fn(),
        ...createRepoUpdateActions(set, get),
        fetchWorktrees: async () => {
          const imported = get().repos.flatMap((row) => row.importedExternalWorktreePaths ?? [])
          if (confirmationFails && imported.length > 0) {
            return false
          }
          const detected = rows.map((row) => ({
            ...row,
            visible: row.visible || imported.includes(row.path)
          }))
          set({
            detectedWorktreesByRepo: {
              project: {
                repoId: 'project',
                authoritative: true,
                source: 'git',
                worktrees: detected
              }
            },
            worktreesByRepo: { project: detected.filter((row) => row.visible) }
          })
          return true
        }
      }) as unknown as AppState
  )
  const synchronize = () => {
    harness.state = store.getState()
  }
  store.subscribe(synchronize)
  synchronize()
  return { store, persisted }
}
async function open(selectedPath: string, executionHostId?: 'local') {
  await openProjectDefaultCheckout({
    repoId: 'project',
    source: 'local_folder_picker',
    selectedPath,
    executionHostId
  })
}
afterEach(() => vi.unstubAllGlobals())
beforeEach(() => {
  vi.clearAllMocks()
})

describe('selected checkout handoff', () => {
  it('opens the deepest hidden checkout and preserves unrelated hidden siblings', async () => {
    const { store, persisted } = setup([
      checkout('/repo'),
      checkout('/repo/nested', { visible: false }),
      checkout('/sibling', { visible: false })
    ])
    await open('/repo/nested/src', 'local')
    expect(harness.activate).toHaveBeenCalledWith('project::/repo/nested', {
      navigationIntent: 'user-open',
      initialCwd: '/repo/nested/src',
      executionHostId: 'local'
    })
    expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/repo/nested'])
    expect(persisted.get('local')?.externalWorktreeVisibility).toBeUndefined()
    expect(store.getState().worktreesByRepo.project.map((row) => row.path)).toEqual([
      '/repo',
      '/repo/nested'
    ])
  })

  it.each(['/unmatched', '/repo/../sibling'])(
    'does not substitute the main checkout for %s',
    async (path) => {
      setup([checkout('/repo')])
      await open(path, 'local')
      expect(harness.activate).not.toHaveBeenCalled()
    }
  )

  it('retains imported intent without activating a substitute when confirmation fails', async () => {
    const { persisted } = setup(
      [checkout('/repo'), checkout('/selected', { visible: false })],
      [repo],
      true
    )
    await open('/selected', 'local')
    expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
    expect(harness.activate).not.toHaveBeenCalled()
  })

  it('ignores a same-id remote checkout and refuses ambiguous owner inference', async () => {
    const remote = { ...repo, executionHostId: 'runtime:remote' as const }
    setup([checkout('/repo'), checkout('/remote', { hostId: 'runtime:remote' })], [repo, remote])
    await open('/remote', 'local')
    await open('/repo')
    expect(harness.activate).not.toHaveBeenCalled()
  })
})

it('preserves imports and delayed initial-card baselines through a failed scan', async () => {
  const { store, persisted } = setup([checkout('/repo')])
  const writeGate = deferred<Repo>()
  harness.persist.mockImplementationOnce(() => writeGate.promise)
  const first = store
    .getState()
    .updateRepo('project', { displayName: 'Renamed' }, { hostId: 'local' })
  const updateRepo: AppState['updateRepo'] = (id, updates) =>
    store.getState().updateRepo(id, updates, { hostId: 'local' })
  const importScan = deferred<boolean>()
  const imported = importNewExternalWorktreeInboxPaths({
    projectId: 'project',
    repo,
    worktreePaths: ['/selected'],
    updateRepo,
    fetchWorktrees: () => importScan.promise,
    setInboxState: vi.fn()
  })
  const card = keepImportedWorktreesHiddenCard({
    projectId: 'project',
    hiddenWorktreePaths: ['/hidden'],
    updateRepo,
    setCardState: vi.fn()
  })
  writeGate.resolve({ ...repo, displayName: 'Renamed' })
  await first
  await card
  importScan.resolve(false)
  await imported
  expect(persisted.get('local')?.importedExternalWorktreePaths).toEqual(['/selected'])
  expect(persisted.get('local')?.externalWorktreeInboxBaselinePaths).toEqual([
    '/selected',
    '/hidden'
  ])
})
