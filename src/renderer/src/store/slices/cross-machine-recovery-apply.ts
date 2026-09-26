import type { StoreApi } from 'zustand'
import type { PreloadApi } from '../../../../preload/api-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  applyCrossMachineRecoveryOp,
  type CrossMachineRecoveryApplyOp,
  type CrossMachineRecoveryApplyOutcome,
  type CrossMachineRecoveryApplyReply,
  type CrossMachineRecoveryApplyRequest,
  type RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { detectLanguage } from '@/lib/language-detect'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import {
  buildHostIdByWorktreeId,
  persistWorkspaceSessionByHost
} from '@/lib/workspace-session-host-persistence'
import type { AppState } from '../types'
import {
  captureRecoveryApplySnapshot,
  rollbackFailedRecoveryApply
} from './cross-machine-recovery-apply-rollback'
import type { OpenFile } from './editor'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'

type RecoveryStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>
type RecoveryPreloadApi = Pick<PreloadApi, 'crossMachineRecovery' | 'session'>

function importedEditorAndBrowserState(
  s: AppState,
  fragment: RecoveryWorkspaceFragment
): Partial<AppState> {
  const worktreeId = fragment.worktreeId
  const usedFileIds = new Set(s.openFiles.map((file) => file.id))
  const fileIdByPath = new Map<string, string>()
  const openFiles: OpenFile[] = fragment.openFiles.map((file) => {
    const id = usedFileIds.has(file.filePath)
      ? buildOwnedEditorFileId(file.filePath, worktreeId, undefined)
      : file.filePath
    usedFileIds.add(id)
    fileIdByPath.set(file.filePath, id)
    return {
      id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId,
      language: detectLanguage(file.relativePath || file.filePath),
      isDirty: false,
      isPreview: file.isPreview,
      ...(file.readOnly ? { readOnly: true } : {}),
      mode: 'edit'
    }
  })
  return {
    openFiles: [...s.openFiles, ...openFiles],
    activeFileIdByWorktree: {
      ...s.activeFileIdByWorktree,
      [worktreeId]: fragment.activeFileId ? (fileIdByPath.get(fragment.activeFileId) ?? null) : null
    },
    browserTabsByWorktree: { ...s.browserTabsByWorktree, [worktreeId]: fragment.browserWorkspaces },
    browserPagesByWorkspace: { ...s.browserPagesByWorkspace, ...fragment.browserPagesByWorkspace },
    activeBrowserTabIdByWorktree: {
      ...s.activeBrowserTabIdByWorktree,
      [worktreeId]: fragment.activeBrowserTabId
    },
    ...(fragment.activeTabType
      ? {
          activeTabTypeByWorktree: {
            ...s.activeTabTypeByWorktree,
            [worktreeId]: fragment.activeTabType
          }
        }
      : {}),
    defaultTerminalTabsAppliedByWorktreeId: {
      ...s.defaultTerminalTabsAppliedByWorktreeId,
      [worktreeId]: true
    }
  }
}

/** Applies a host-authored recovery op to the live store synchronously; the shared reducer owns semantics. */
export function applyCrossMachineRecoveryOpToStore(
  store: RecoveryStore,
  op: CrossMachineRecoveryApplyOp
): CrossMachineRecoveryApplyOutcome {
  const state = store.getState()
  if (op.kind !== 'import') {
    const { session, outcome } = applyCrossMachineRecoveryOp(
      {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey
      },
      op
    )
    store.setState({ sleepingAgentSessionsByPaneKey: session.sleepingAgentSessionsByPaneKey ?? {} })
    return outcome
  }
  // Why: the not-empty check must see live tabs the debounced writer has not persisted yet.
  const { session, outcome } = applyCrossMachineRecoveryOp(buildWorkspaceSessionPayload(state), op)
  if (!outcome.ok) {
    return outcome
  }
  const replaceWorkspaceKeys = [op.fragment.worktreeId]
  state.hydrateWorkspaceSession(session, { replaceWorkspaceKeys })
  state.hydrateTabsSession(session, { replaceWorkspaceKeys })
  store.setState((s) => importedEditorAndBrowserState(s, op.fragment))
  return outcome
}

// Why: hydration silently drops rows for worktrees missing from the catalog, and reposync may have just restored this checkout.
async function ensureLocalDestinationKnown(
  store: RecoveryStore,
  worktreeId: string
): Promise<void> {
  const isKnownLocally = (): boolean =>
    Boolean(store.getState().getKnownWorktreeById(worktreeId, LOCAL_EXECUTION_HOST_ID))
  if (!isKnownLocally()) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (!store.getState().repos.some((repo) => repo.id === repoId)) {
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    }
    await store.getState().fetchWorktrees(repoId, { forceLocalOwner: true })
    if (!isKnownLocally()) {
      throw new Error(`Recovery destination ${worktreeId} is not a known local worktree`)
    }
  }
  // Why: a same-id worktree on another host can own the partition this write would land in.
  const partitionHostId = buildHostIdByWorktreeId(store.getState())(worktreeId)
  if (partitionHostId !== LOCAL_EXECUTION_HOST_ID) {
    throw new Error(`Recovery destination ${worktreeId} persists to ${partitionHostId}, not local`)
  }
}

export async function handleCrossMachineRecoveryApplyRequest(
  store: RecoveryStore,
  api: RecoveryPreloadApi,
  request: CrossMachineRecoveryApplyRequest
): Promise<CrossMachineRecoveryApplyReply> {
  try {
    if (request.op.kind === 'import') {
      await ensureLocalDestinationKnown(store, request.op.fragment.worktreeId)
    }
    const snapshot = captureRecoveryApplySnapshot(store, request.op)
    const outcome = applyCrossMachineRecoveryOpToStore(store, request.op)
    if (outcome.ok) {
      const state = store.getState()
      const stagedRecords = state.sleepingAgentSessionsByPaneKey
      try {
        // Why: the host treats this reply as the durability boundary before resuming or reporting.
        await persistWorkspaceSessionByHost(api.session, buildWorkspaceSessionPayload(state), state)
      } catch (error) {
        // Why: main never receives a record claimed here, so only this rollback can restore it.
        rollbackFailedRecoveryApply(store, request.op, snapshot, stagedRecords)
        throw error
      }
    }
    return { requestId: request.requestId, outcome }
  } catch (error) {
    return {
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function installCrossMachineRecoveryApplyBridge(
  store: RecoveryStore,
  api: RecoveryPreloadApi
): () => void {
  return api.crossMachineRecovery.onApply((request) => {
    void handleCrossMachineRecoveryApplyRequest(store, api, request).then((reply) =>
      api.crossMachineRecovery.reply(reply)
    )
  })
}
