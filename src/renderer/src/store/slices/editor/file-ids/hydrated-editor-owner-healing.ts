import type { Tab } from '../../../../../../shared/tab-types'
import type { PersistedOpenFile } from '../../../../../../shared/workspace-session-state-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { findFolderWorkspaceOwner } from '@/lib/folder-workspace-runtime-owner'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
import { findIndexedProjectGroupOwner } from '@/lib/worktree-runtime-owner-index'
import {
  resolveExplicitWorktreeOperationRouteResult,
  type WorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import { isEditorTabContentType } from '../tabs/editor-tab-content-type'
import { buildOwnedEditorFileId } from './editor-file-ids'
import { editorDocumentIdentityKey, runtimeOwnerKey } from './editor-document-identity'

export type HealedPersistedEditorFile = {
  /** Survivor record, carrying the route owner when the heal applied. */
  file: PersistedOpenFile
  /** Ids the merged-away duplicates would have restored under. */
  supersededIds: readonly string[]
  /** The record now follows the worktree route, so its tabs may be re-stamped too. */
  ownerNormalized: boolean
}

export type HealedPersistedEditorFilePlan = {
  files: HealedPersistedEditorFile[]
  /**
   * Drafts that cannot restore as their own tab: the persisted schema identifies a document by
   * (owner, path), so a second record with the same owner has no id of its own. Their content is
   * handed back for the reopen stack instead of being dropped on the floor.
   */
  recoverableDrafts: PersistedOpenFile[]
  droppedCount: number
  ownerRewrittenCount: number
  divergentDraftGroupCount: number
}

const stampedRouteStateCache = new WeakMap<
  WorktreeOperationRouteState,
  WorktreeOperationRouteState
>()

/** One focus-suppressed copy per store snapshot, so a many-workspace hydration re-spreads nothing. */
function stampedRouteState(state: WorktreeOperationRouteState): WorktreeOperationRouteState {
  const cached = stampedRouteStateCache.get(state)
  if (cached) {
    return cached
  }
  const next = { ...state, activeWorkspaceExecutionHostId: null, settings: null }
  stampedRouteStateCache.set(state, next)
  return next
}

function routeForStampedHost(hostId: string | null | undefined): WorktreeOperationRoute | null {
  const parsed = parseExecutionHostId(hostId)
  return parsed
    ? {
        executionHostId: parsed.id,
        runtimeEnvironmentId: parsed.kind === 'runtime' ? parsed.environmentId : null
      }
    : null
}

/**
 * A folder workspace's owner, taken only from evidence someone wrote down: the folder or project
 * group row's host, its SSH connection, or the per-host session partition it restored from.
 * `getExecutionHostIdForFolderWorkspace` cannot be used here — it defaults to `local`, and a
 * default is not evidence that the records are local.
 */
function resolveStampedFolderWorkspaceRoute(
  state: WorktreeOperationRouteState,
  folderWorkspaceId: string
): WorktreeOperationRoute | null {
  const folderWorkspace = findFolderWorkspaceOwner(state, folderWorkspaceId)
  if (!folderWorkspace) {
    return null
  }
  const projectGroup = findIndexedProjectGroupOwner(
    state.projectGroups,
    folderWorkspace.projectGroupId
  )
  const connectionId =
    folderWorkspace.connectionId?.trim() || projectGroup?.connectionId?.trim() || null
  return (
    routeForStampedHost(folderWorkspace.executionHostId ?? projectGroup?.executionHostId) ??
    (connectionId ? routeForStampedHost(toSshExecutionHostId(connectionId)) : null) ??
    routeForStampedHost(
      state.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folderWorkspaceId)]
    )
  )
}

/**
 * The owner a worktree's editor records must agree with, or `null` when nothing stamped can
 * place it. Both focus signals — the active workspace's host selection and the focused runtime
 * environment — are suppressed, because UI focus leaking into ownership is what wrote the
 * corrupt owners this heal removes. Git ids resolve from stamped catalog rows only; the legacy
 * unstamped fallbacks below them are inference, and inference is not a licence to rewrite an
 * owner. Folder workspaces have no catalog, so their own owner record plays that role.
 */
export function resolveHealableWorktreeOwnerRoute(
  state: WorktreeOperationRouteState,
  worktreeId: string
): WorktreeOperationRoute | null {
  const stampedState = stampedRouteState(state)
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return resolveStampedFolderWorkspaceRoute(stampedState, workspaceScope.folderWorkspaceId)
  }
  const resolution = resolveExplicitWorktreeOperationRouteResult(stampedState, worktreeId)
  return resolution.kind === 'resolved' ? resolution.route : null
}

/** Why no liveTail term: a pinned read-only log and an SSH-pinned external path name their own host,
 *  and `editorDocumentIdentityKey` only reads liveTail on a read-only row, already excluded here. */
function isOwnerHealable(file: PersistedOpenFile): boolean {
  return file.readOnly !== true && !file.externalSshTargetId?.trim()
}

function restoredIdCandidates(file: PersistedOpenFile, worktreeId: string): string[] {
  return [
    file.filePath,
    buildOwnedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
  ]
}

function pickSurvivor(
  files: readonly PersistedOpenFile[],
  worktreeId: string,
  persistedActiveFileId: string | null | undefined
): PersistedOpenFile {
  const drafted = files.find((file) => file.dirtyDraftContent !== undefined)
  if (drafted) {
    // Why the equal-draft scan: same text means the same document, so keep the copy that still
    // carries the disk baseline — the restored draft has nothing to verify against without it.
    return (
      files.find(
        (file) =>
          file.dirtyDraftContent === drafted.dirtyDraftContent &&
          file.lastKnownDiskSignature !== undefined
      ) ?? drafted
    )
  }
  const active =
    persistedActiveFileId != null
      ? files.find((file) => restoredIdCandidates(file, worktreeId).includes(persistedActiveFileId))
      : undefined
  return active ?? files[0]
}

function countDistinctDrafts(files: readonly PersistedOpenFile[]): number {
  return new Set(
    files.flatMap((file) => (file.dirtyDraftContent !== undefined ? [file.dirtyDraftContent] : []))
  ).size
}

function groupByIdentity(
  files: readonly PersistedOpenFile[],
  worktreeId: string,
  ownerOf: (file: PersistedOpenFile) => string | null
): Map<string, PersistedOpenFile[]> {
  const groups = new Map<string, PersistedOpenFile[]>()
  for (const file of files) {
    // Why the bucket's worktreeId, not the record's: a record whose own worktreeId drifted is
    // exactly the corruption this heal merges, so it must not split the group.
    const key = editorDocumentIdentityKey({ ...file, worktreeId }, ownerOf(file))
    const group = groups.get(key)
    if (group) {
      group.push(file)
      continue
    }
    groups.set(key, [file])
  }
  return groups
}

/**
 * Collapse one worktree's persisted editor records onto one survivor per document, normalizing
 * owners to the worktree's resolved route. Duplicates whose unsaved drafts disagree are kept
 * apart instead: a merge would destroy one of them.
 */
export function planHealedPersistedEditorFiles(args: {
  files: readonly PersistedOpenFile[]
  worktreeId: string
  route: WorktreeOperationRoute | null
  persistedActiveFileId: string | null | undefined
}): HealedPersistedEditorFilePlan {
  const { files, worktreeId, route, persistedActiveFileId } = args
  const verbatimOwner = (file: PersistedOpenFile): string | null =>
    runtimeOwnerKey(file.runtimeEnvironmentId)
  const healedOwner = (file: PersistedOpenFile): string | null =>
    route && isOwnerHealable(file)
      ? runtimeOwnerKey(route.runtimeEnvironmentId)
      : verbatimOwner(file)

  const survivors: {
    file: PersistedOpenFile
    /** Records whose restored ids must be redirected onto the survivor — merged siblings, plus
     *  the survivor's own pre-heal identity when the route re-owned it. */
    superseded: PersistedOpenFile[]
    droppedCount: number
    ownerRewritten: boolean
  }[] = []
  let divergentDraftGroupCount = 0
  const recoverableDrafts: PersistedOpenFile[] = []
  for (const group of groupByIdentity(files, worktreeId, healedOwner).values()) {
    if (countDistinctDrafts(group) > 1) {
      divergentDraftGroupCount += 1
      for (const verbatimGroup of groupByIdentity(group, worktreeId, verbatimOwner).values()) {
        const file = pickSurvivor(verbatimGroup, worktreeId, persistedActiveFileId)
        const superseded = verbatimGroup.filter((entry) => entry !== file)
        // Same owner and path as the survivor: no second id exists, so the draft leaves as a reopen snapshot.
        for (const entry of superseded) {
          if (
            entry.dirtyDraftContent !== undefined &&
            entry.dirtyDraftContent !== file.dirtyDraftContent &&
            // Why: a read-only row must restore clean, and the reopen snapshot drops readOnly/liveTail
            // and reopens as 'edit' — parking its draft would hand back a writable dirty log tab.
            entry.readOnly !== true
          ) {
            recoverableDrafts.push(entry)
          }
        }
        survivors.push({
          file,
          superseded,
          droppedCount: superseded.length,
          ownerRewritten: false
        })
      }
      continue
    }
    const picked = pickSurvivor(group, worktreeId, persistedActiveFileId)
    const owner = healedOwner(picked)
    const ownerRewritten = group.some((entry) => verbatimOwner(entry) !== owner)
    const dropped = group.filter((entry) => entry !== picked)
    survivors.push({
      file: owner === verbatimOwner(picked) ? picked : { ...picked, runtimeEnvironmentId: owner },
      superseded: owner === verbatimOwner(picked) ? dropped : [picked, ...dropped],
      droppedCount: dropped.length,
      ownerRewritten
    })
  }

  const survivorCountByPath = new Map<string, number>()
  for (const { file } of survivors) {
    survivorCountByPath.set(file.filePath, (survivorCountByPath.get(file.filePath) ?? 0) + 1)
  }
  let droppedCount = 0
  let ownerRewrittenCount = 0
  const healedFiles = survivors.map((survivor) => {
    const { file, superseded, ownerRewritten } = survivor
    droppedCount += survivor.droppedCount
    // Why the owner comparison: a divergent-draft survivor keeps its verbatim owner, so re-stamping
    // its tabs would make them describe a record that still follows a different route.
    const ownerNormalized =
      route !== null &&
      isOwnerHealable(file) &&
      runtimeOwnerKey(file.runtimeEnvironmentId) === runtimeOwnerKey(route.runtimeEnvironmentId)
    if (ownerRewritten) {
      ownerRewrittenCount += 1
    }
    const supersededIds = superseded.flatMap((entry) =>
      restoredIdCandidates(entry, worktreeId).filter(
        // Why: a plain path id is only unambiguous while one survivor owns that path.
        (id) => id !== entry.filePath || survivorCountByPath.get(entry.filePath) === 1
      )
    )
    return { file, supersededIds, ownerNormalized }
  })

  return {
    files: healedFiles,
    recoverableDrafts,
    droppedCount,
    ownerRewrittenCount,
    divergentDraftGroupCount
  }
}

/**
 * A stamp the route already names. An SSH worktree reached through a paired HUB routes as
 * `{ ssh:conn, runtime:hub }`, and `runtime:hub` is a correct stamp for it — equality alone would
 * rewrite those tabs on every hydration. A route with no host names no alias, so its tabs are
 * unstamped as before.
 */
function isEditorTabHostOnRoute(
  executionHostId: ExecutionHostId,
  route: WorktreeOperationRoute
): boolean {
  return (
    route.executionHostId !== null &&
    isExecutionHostAliasForWorktree(executionHostId, {
      hostId: route.executionHostId,
      runtimeOwnerEnvironmentId: route.runtimeEnvironmentId ?? undefined
    })
  )
}

function withEditorTabExecutionHost(tab: Tab, executionHostId: ExecutionHostId | null): Tab {
  const { executionHostId: previousHostId, ...withoutHost } = tab
  void previousHostId
  return executionHostId ? { ...withoutHost, executionHostId } : withoutHost
}

export type HealedEditorTabHostTarget = {
  fileIds: ReadonlySet<string>
  route: WorktreeOperationRoute
}

/**
 * Re-stamp editor tabs that name a host the worktree's route contradicts. Such a tab keeps
 * failing `isUnifiedTabOwnedByWorktree` for its own worktree. Unstamped tabs stay unstamped.
 */
export function alignHealedEditorTabHosts(
  tabsByWorktree: Record<string, Tab[]>,
  targetsByWorktree: Record<string, HealedEditorTabHostTarget>
): Record<string, Tab[]> | null {
  let anyChanged = false
  const next: Record<string, Tab[]> = { ...tabsByWorktree }
  for (const [worktreeId, { fileIds, route }] of Object.entries(targetsByWorktree)) {
    const tabs = tabsByWorktree[worktreeId]
    if (!tabs) {
      continue
    }
    let changed = false
    const nextTabs = tabs.map((tab) => {
      if (
        !isEditorTabContentType(tab.contentType) ||
        !fileIds.has(tab.entityId) ||
        // Why: only a stamp that contradicts the route is corrected — stamping an unstamped tab is a different change.
        !tab.executionHostId ||
        isEditorTabHostOnRoute(tab.executionHostId, route)
      ) {
        return tab
      }
      changed = true
      return withEditorTabExecutionHost(tab, route.executionHostId)
    })
    if (changed) {
      anyChanged = true
      next[worktreeId] = nextTabs
    }
  }
  return anyChanged ? next : null
}
