import { vi, type Mock } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { DetectedWorktree } from '../../../../../../shared/worktree/types'
import { createRepoUpdateActions } from '@/store/repos/repo-update'
import { createRepoAddActions } from '@/store/repos/repo-add-actions'
import { openProjectDefaultCheckout } from './project-added-default-checkout'

export type PersistRequest = { repoId: string; updates: object; hostId?: string }
export type ToastOptions = { description?: string; action?: { onClick: () => void } }
export type ActivateOptions = {
  navigationIntent?: string
  initialCwd?: string
  executionHostId?: string
}
export type AddRequest = { path: string; kind?: string; displayName?: string }
export type ProfileLookupRequest = {
  path: string
  connectionId: string | null
  executionHostId: string
  excludeProfileId: string
}
export type Harness = {
  state: AppState | null
  activate: Mock<(worktreeId: string, options: ActivateOptions) => void>
  persist: Mock<(request: PersistRequest) => Promise<Repo>>
  subscribe: Mock<(listener: (state: AppState) => void) => () => void>
  error: Mock<(message: string, options: ToastOptions) => void>
  onboarding: Mock<(step: string) => Promise<void>>
  add: Mock<(request: AddRequest) => Promise<unknown>>
  warning: Mock<(message: string, options: ToastOptions) => void>
  findProjectProfiles: Mock<
    (request: ProfileLookupRequest) => Promise<{ projects: { profileName: string }[] }>
  >
}
export const repo: Repo = {
  id: 'project',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '',
  addedAt: 0,
  kind: 'git'
}
export function checkout(path: string, extra: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    id: `project::${path}`,
    repoId: 'project',
    path,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    branch: 'topic',
    head: 'abc',
    isBare: false,
    ownership: 'external',
    selectedCheckout: path === '/repo',
    isMainWorktree: path === '/repo',
    isArchived: false,
    lastActivityAt: 0,
    visible: true,
    ...extra
  }
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
/** The handoff's app store over the given rows, wired to the test file's mocked harness. */
export function createSetup(harness: Harness) {
  return function setup(
    rows: DetectedWorktree[],
    repos: Repo[] = [repo],
    confirmationFails = false
  ) {
    let failing = confirmationFails
    const persisted = new Map<string, Repo>(
      repos.map((row) => [row.executionHostId ?? 'local', row])
    )
    harness.persist.mockImplementation(async ({ updates, hostId }) => {
      const owner = hostId ?? 'local'
      const next = { ...persisted.get(owner)!, ...updates }
      persisted.set(owner, next)
      return next
    })
    vi.stubGlobal(
      'window',
      Object.assign(window, {
        api: {
          repos: { update: harness.persist, add: harness.add },
          orcaProfiles: { findProjectProfiles: harness.findProjectProfiles }
        }
      })
    )
    const store = createStore<AppState>()(
      (set, get) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every field read by the handoff and updater; unrelated app slices are not exercised.
        ({
          repos,
          projects: [],
          projectHostSetups: [],
          settings: {},
          activeModal: 'none',
          modalData: {},
          activeView: 'terminal',
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null,
          activeTabType: 'terminal',
          activeTabId: null,
          activeBrowserTabId: null,
          activeFileId: null,
          activeGroupIdByWorktree: {},
          groupsByWorktree: {},
          browserTabsByWorktree: {},
          activeRepoId: null,
          showActiveOnly: false,
          setFilterRepoIds: vi.fn(),
          setShowActiveOnly: vi.fn(),
          worktreesByRepo: {},
          detectedWorktreesByRepo: {},
          hideDefaultBranchWorkspace: true,
          filterRepoIds: [],
          showSleepingWorkspaces: true,
          setActiveRepo: vi.fn(),
          setProjectFilterIds: vi.fn(),
          ...createRepoUpdateActions(set, get),
          ...createRepoAddActions(set, get),
          clearOrcaHookTrustForRepo: vi.fn(),
          activeOrcaProfileId: null,
          openModal: (
            activeModal: AppState['activeModal'],
            modalData: AppState['modalData'] = {}
          ) => set({ activeModal, modalData }),
          closeModal: () => set({ activeModal: 'none', modalData: {} }),
          fetchWorktrees: async () => {
            const imported = get().repos.flatMap((row) => row.importedExternalWorktreePaths ?? [])
            if (failing && imported.length > 0) {
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
    harness.subscribe.mockImplementation((listener) => store.subscribe(listener))
    store.subscribe(synchronize)
    synchronize()
    return {
      store,
      persisted,
      recover: () => {
        failing = false
      }
    }
  }
}

export async function open(selectedPath: string, executionHostId?: 'local' | 'runtime:env') {
  await openProjectDefaultCheckout({
    repoId: 'project',
    source: 'local_folder_picker',
    selectedPath,
    executionHostId
  })
}
