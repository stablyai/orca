import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { AppState } from '@/store/types'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { markOnboardingProjectAdded } from './onboarding-project-checklist'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

export function showQuickChatFailure(): void {
  toast.error(
    translate('quickChat.failed', 'Could not start a chat. Check the Chats folder and try again.')
  )
}

export type QuickChatDestination = { repoId: string; worktreeId: string }
type Preparation = {
  promise: Promise<QuickChatDestination | null>
  retired: boolean
  retire: () => void
}
const preparations = new WeakMap<AppState['addRepoPath'], Map<string, Preparation>>()

export async function startQuickChat(): Promise<QuickChatDestination | null> {
  const initial = useAppStore.getState()
  try {
    const { path, repoId } = await window.api.repos.ensureQuickChatFolder()
    const store = useAppStore.getState()
    if (
      repoId &&
      initial.repos.some(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ) &&
      !store.repos.some(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
    ) {
      return null
    }
    let pending = preparations.get(store.addRepoPath)
    if (!pending) {
      pending = new Map()
      preparations.set(store.addRepoPath, pending)
    }
    let preparation = pending.get(path)
    if (!preparation || preparation.retired) {
      const retirement = Promise.withResolvers<null>()
      const entry: Preparation = {
        promise: Promise.resolve(null),
        retired: false,
        retire: () => {
          entry.retired = true
          retirement.resolve(null)
        }
      }
      entry.promise = Promise.race([
        prepareQuickChat(path, repoId, entry).catch(() => {
          if (!entry.retired) {
            showQuickChatFailure()
          }
          return null
        }),
        retirement.promise
      ])
      pending.set(path, entry)
      preparation = entry
    }
    try {
      return await preparation.promise
    } finally {
      if (pending.get(path) === preparation) {
        pending.delete(path)
      }
    }
  } catch {
    showQuickChatFailure()
    return null
  }
}

async function prepareQuickChat(
  path: string,
  repoId: string | undefined,
  preparation: Preparation
): Promise<QuickChatDestination | null> {
  const store = useAppStore.getState()
  let observedId = repoId
  let seen = false
  let stop = () => {}
  const observe = () => {
    observedId ??= useAppStore
      .getState()
      .repos.find(
        (repo) =>
          getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
          normalizeRuntimePathForComparison(repo.path) === normalizeRuntimePathForComparison(path)
      )?.id
    const exists = useAppStore
      .getState()
      .repos.some(
        (repo) => repo.id === observedId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
    if (seen && !exists) {
      preparation.retire()
      stop()
    }
    seen ||= exists
  }
  observe()
  stop = useAppStore.subscribe(observe)
  try {
    const repo =
      store.repos.find(
        (repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ) ??
      (await store.addRepoPath(path, 'folder', {
        runtimeEnvironmentId: null,
        displayName: translate('quickChat.projectName', 'Chats')
      }))
    // addRepoPath owns its failure toast.
    if (!repo || preparation.retired) {
      return null
    }
    observedId = repo.id
    observe()
    void markOnboardingProjectAdded('addedFolder').catch(() => {})
    const currentRepo = () =>
      !preparation.retired &&
      useAppStore
        .getState()
        .repos.some(
          (row) => row.id === repo.id && getRepoExecutionHostId(row) === LOCAL_EXECUTION_HOST_ID
        )
    if (
      !currentRepo() ||
      !(await store.fetchWorktrees(repo.id, { executionHostId: LOCAL_EXECUTION_HOST_ID }))
    ) {
      if (!preparation.retired) {
        showQuickChatFailure()
      }
      return null
    }
    const worktree = selectWorktreesByRepo(useAppStore.getState())[repo.id]?.find(
      (worktree) =>
        worktree.hostId === LOCAL_EXECUTION_HOST_ID &&
        normalizeRuntimePathForComparison(worktree.path) ===
          normalizeRuntimePathForComparison(repo.path)
    )
    if (!currentRepo() || !worktree) {
      if (!preparation.retired) {
        showQuickChatFailure()
      }
      return null
    }
    return { repoId: repo.id, worktreeId: worktree.id }
  } finally {
    stop()
  }
}
