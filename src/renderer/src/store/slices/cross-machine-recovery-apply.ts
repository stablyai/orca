import type { StoreApi } from 'zustand'
import type { PreloadApi } from '../../../../preload/api-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  applyCrossMachineRecoveryOp,
  type CrossMachineRecoveryApplyOp,
  type CrossMachineRecoveryApplyOutcome,
  type CrossMachineRecoveryApplyReply,
  type CrossMachineRecoveryApplyRequest,
  type RecoveryWorkspaceFragment
} from '../../../../shared/cross-machine-recovery-session-ops'
import { detectLanguage } from '@/lib/language-detect'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { persistWorkspaceSessionByHost } from '@/lib/workspace-session-host-persistence'
import type { AppState } from '../types'
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

export async function handleCrossMachineRecoveryApplyRequest(
  store: RecoveryStore,
  api: RecoveryPreloadApi,
  request: CrossMachineRecoveryApplyRequest
): Promise<CrossMachineRecoveryApplyReply> {
  try {
    const outcome = applyCrossMachineRecoveryOpToStore(store, request.op)
    if (outcome.ok) {
      // Why: the host treats this reply as the durability boundary before resuming or reporting.
      const state = store.getState()
      await persistWorkspaceSessionByHost(api.session, buildWorkspaceSessionPayload(state), state)
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
