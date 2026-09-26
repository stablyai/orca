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
import { rollbackFailedRecoveryApply } from './cross-machine-recovery-apply-rollback'
import type { OpenFile } from './editor'
import { resolveEditorFileIdForOwner } from './editor/file-ids/editor-file-ids'
import {
  addEditorFileIdMigration,
  migrateEditorFileId,
  migrateHydratedEditorTabsAndGroups
} from './editor/file-ids/hydrated-editor-file-ids'

type RecoveryStore = Pick<StoreApi<AppState>, 'getState' | 'setState'>
type RecoveryPreloadApi = Pick<PreloadApi, 'crossMachineRecovery' | 'session'>

type DestinationEditors = { fragment: RecoveryWorkspaceFragment; openFiles: OpenFile[] }

// Why: a path another owner already holds gets a scoped file id, so the tabs, groups and
// selections that name the file by path must move to that id before hydration.
function withDestinationEditorIds(
  s: AppState,
  fragment: RecoveryWorkspaceFragment
): DestinationEditors {
  const worktreeId = fragment.worktreeId
  const pool: OpenFile[] = [...s.openFiles]
  const openFiles: OpenFile[] = []
  const migrations: Record<string, Map<string, string>> = {}
  for (const file of fragment.openFiles) {
    const id = resolveEditorFileIdForOwner(
      { openFiles: pool },
      file.filePath,
      worktreeId,
      undefined,
      ['edit']
    )
    if (openFiles.some((opened) => opened.id === id)) {
      continue
    }
    addEditorFileIdMigration(migrations, worktreeId, file.filePath, id)
    const openFile: OpenFile = {
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
    pool.push(openFile)
    openFiles.push(openFile)
  }
  if (!migrations[worktreeId]) {
    return { fragment, openFiles }
  }
  const migrated = migrateHydratedEditorTabsAndGroups(
    {
      unifiedTabsByWorktree: { [worktreeId]: fragment.unifiedTabs },
      groupsByWorktree: { [worktreeId]: fragment.tabGroups }
    },
    migrations
  )
  return {
    openFiles,
    fragment: {
      ...fragment,
      unifiedTabs: migrated.unifiedTabsByWorktree?.[worktreeId] ?? fragment.unifiedTabs,
      tabGroups: migrated.groupsByWorktree?.[worktreeId] ?? fragment.tabGroups,
      activeFileId: migrateEditorFileId(migrations, worktreeId, fragment.activeFileId),
      activeTabId: migrateEditorFileId(migrations, worktreeId, fragment.activeTabId)
    }
  }
}

function importedEditorAndBrowserState(
  s: AppState,
  { fragment, openFiles }: DestinationEditors
): Partial<AppState> {
  const worktreeId = fragment.worktreeId
  return {
    openFiles: [...s.openFiles, ...openFiles],
    activeFileIdByWorktree: {
      ...s.activeFileIdByWorktree,
      [worktreeId]: fragment.activeFileId
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
  const destination = withDestinationEditorIds(state, op.fragment)
  // Why: the not-empty check must see live tabs the debounced writer has not persisted yet.
  const { session, outcome } = applyCrossMachineRecoveryOp(buildWorkspaceSessionPayload(state), {
    ...op,
    fragment: destination.fragment
  })
  if (!outcome.ok || outcome.alreadyApplied) {
    return outcome
  }
  const replaceWorkspaceKeys = [op.fragment.worktreeId]
  state.hydrateWorkspaceSession(session, { replaceWorkspaceKeys })
  state.hydrateTabsSession(session, { replaceWorkspaceKeys })
  store.setState((s) => importedEditorAndBrowserState(s, destination))
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

function recoveryApplyDestinations(op: CrossMachineRecoveryApplyOp): string[] {
  switch (op.kind) {
    case 'import':
      return [op.fragment.worktreeId]
    case 'merge-records':
      return [...new Set(op.records.map((record) => record.worktreeId))]
    case 'claim-record':
      return [op.worktreeId]
    case 'restore-record':
      return [op.record.worktreeId]
  }
}

const applyTailsByStore = new WeakMap<RecoveryStore, Map<string, Promise<void>>>()

// Why: the host's timeout leaves an earlier apply running, so a retry must judge the destination
// only after that apply persisted or rolled back, or its rollback erases the acknowledged retry.
async function serializedByDestination<T>(
  store: RecoveryStore,
  destinations: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  const tails = applyTailsByStore.get(store) ?? new Map<string, Promise<void>>()
  applyTailsByStore.set(store, tails)
  const predecessors = destinations.flatMap((destination) => tails.get(destination) ?? [])
  const current = Promise.all(predecessors).then(run)
  const settled = current.then(
    () => undefined,
    () => undefined
  )
  for (const destination of destinations) {
    tails.set(destination, settled)
  }
  try {
    return await current
  } finally {
    for (const destination of destinations) {
      if (tails.get(destination) === settled) {
        tails.delete(destination)
      }
    }
  }
}

async function applyAndPersist(
  store: RecoveryStore,
  api: RecoveryPreloadApi,
  op: CrossMachineRecoveryApplyOp
): Promise<CrossMachineRecoveryApplyOutcome> {
  if (op.kind === 'import') {
    await ensureLocalDestinationKnown(store, op.fragment.worktreeId)
  }
  const before = store.getState()
  const outcome = applyCrossMachineRecoveryOpToStore(store, op)
  if (!outcome.ok) {
    return outcome
  }
  const staged = store.getState()
  try {
    // Why: the host treats this reply as the durability boundary before resuming or reporting.
    await persistWorkspaceSessionByHost(api.session, buildWorkspaceSessionPayload(staged), staged)
  } catch (error) {
    // Why: main never receives a record claimed here, so only this rollback can restore it;
    // a replay applied nothing, so rolling back would erase tabs opened since the import.
    if (!outcome.alreadyApplied) {
      rollbackFailedRecoveryApply(store, op, before, staged)
    }
    throw error
  }
  return outcome
}

export async function handleCrossMachineRecoveryApplyRequest(
  store: RecoveryStore,
  api: RecoveryPreloadApi,
  request: CrossMachineRecoveryApplyRequest
): Promise<CrossMachineRecoveryApplyReply> {
  try {
    const outcome = await serializedByDestination(
      store,
      recoveryApplyDestinations(request.op),
      () => applyAndPersist(store, api, request.op)
    )
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
