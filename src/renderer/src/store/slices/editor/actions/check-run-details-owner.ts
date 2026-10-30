import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { OpenCheckRunDetailsState } from '../../../../../../shared/editor-tab-view-types'
import { getCheckRunTabIdentity } from '@/components/editor/check-run-details-tab'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../../shared/execution-host'
import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/unified-tab-host-ownership'
import { findIndexedDetectedWorktrees } from '@/lib/worktree-runtime-owner-index'
import { layoutFrameWorkspace } from '@/runtime/layout-frame-workspaces'
import {
  resolveWorktreeOperationRoute,
  resolveWorktreeOperationRouteForHost,
  type WorktreeOperationOwnerRecord,
  type WorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { onPairedWebClientHost } from '@/lib/paired-web-client-host'
import { captureWorktreeOperationGenerationSnapshot } from '@/lib/worktree-operation-generation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '../../../workspace-record-selectors'

export type CheckRunDetailsOwnership = Pick<
  OpenFile,
  'runtimeEnvironmentId' | 'operationProvenance'
>

type CheckRunDetailsOwnerFile = Pick<
  OpenFile,
  'id' | 'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'worktreeId'
>

export function resolveCheckRunDetailsOwnership(
  state: AppState,
  worktreeId: string
): CheckRunDetailsOwnership | null {
  const route = resolveWorktreeOperationRoute(
    { ...state, worktreesByRepo: selectWorktreesByRepo(state) },
    worktreeId
  )
  return route
    ? {
        runtimeEnvironmentId: route.runtimeEnvironmentId,
        operationProvenance: {
          generation: captureWorktreeOperationGenerationSnapshot(route),
          ownershipProjection: 'explicit'
        }
      }
    : null
}

/** Worktree ids repeat across hosts, so a remote owner keys its own tab instead of taking over a twin's. */
export function getCheckRunDetailsOwnerScope(
  ownership: CheckRunDetailsOwnership | null
): string | null {
  if (!ownership) {
    return null
  }
  const hostId = getOpenFileExecutionHostId(ownership)
  const runtimeId = ownership.runtimeEnvironmentId?.trim()
  const runtimeHostId = runtimeId ? toRuntimeExecutionHostId(runtimeId) : null
  // Why: a paired server can proxy an SSH host the app also reaches directly; each is its own transport.
  const scope = runtimeHostId && runtimeHostId !== hostId ? `${hostId}>${runtimeHostId}` : hostId
  // Local keeps the unscoped id so tabs opened before host scoping still match.
  return scope === LOCAL_EXECUTION_HOST_ID ? null : scope
}

export function isSameCheckRunDetailsOwner(
  file: CheckRunDetailsOwnerFile,
  ownership: CheckRunDetailsOwnership | null
): boolean {
  return (
    ownership !== null &&
    hasOpenFileExecutionHostEvidence(file) &&
    getOpenFileExecutionHostId(file) === getOpenFileExecutionHostId(ownership) &&
    (file.runtimeEnvironmentId?.trim() || null) === (ownership.runtimeEnvironmentId?.trim() || null)
  )
}

/** The tab a sidebar request stamped when it started; the host selected at completion can differ. */
export function findCheckRunDetailsRequestTabId(
  openFiles: readonly OpenFile[],
  worktreeId: string,
  check: OpenCheckRunDetailsState['check'],
  requestId: number | undefined
): string | null {
  if (requestId === undefined) {
    return null
  }
  const identity = getCheckRunTabIdentity(check)
  const tab = openFiles.find(
    (file) =>
      file.mode === 'check-details' &&
      file.worktreeId === worktreeId &&
      file.checkRunDetails?.requestId === requestId &&
      getCheckRunTabIdentity(file.checkRunDetails.check) === identity
  )
  return tab?.id ?? null
}

function runtimeOf(route: WorktreeOperationRoute): string | null {
  return route.runtimeEnvironmentId?.trim() || null
}

function getTabRoute(file: CheckRunDetailsOwnerFile): WorktreeOperationRoute {
  return (
    file.operationProvenance?.generation.route ?? {
      executionHostId: getOpenFileExecutionHostId(file),
      runtimeEnvironmentId: file.runtimeEnvironmentId?.trim() || null
    }
  )
}

function getFramedTabRoute(file: CheckRunDetailsOwnerFile): WorktreeOperationRoute | null {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return null
  }
  const tabs = layoutFrameWorkspace(file.worktreeId)?.tabs.filter(
    (tab) => tab.kind === 'check-details' && tab.entityId === file.id
  )
  const hosts = new Set(tabs?.map((tab) => tab.executionHostId))
  const host = hosts.size === 1 ? parseExecutionHostId(hosts.values().next().value) : null
  return host
    ? {
        executionHostId: host.id,
        runtimeEnvironmentId:
          file.runtimeEnvironmentId?.trim() || (host.kind === 'runtime' ? host.environmentId : null)
      }
    : null
}

/** The route a listing row is reached through, with a legacy SSH row's server recovered from its repo. */
function getRowRoute(state: AppState, row: WorktreeOperationOwnerRecord) {
  if (!row.hostId && !row.runtimeOwnerEnvironmentId?.trim()) {
    return onPairedWebClientHost(state, {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      runtimeEnvironmentId: null
    })
  }
  const resolution = resolveExactWorktreeRoute(state, row)
  if (resolution.kind === 'resolved') {
    return onPairedWebClientHost(state, resolution.route)
  }
  if (resolution.kind !== 'ambiguous' || !row.hostId) {
    return null
  }
  // Opening can prove a direct listing despite a repo proxy; retain that fallback without adopting a server's row.
  const directRoute = onPairedWebClientHost(state, {
    executionHostId: row.hostId,
    runtimeEnvironmentId: null
  })
  const qualifiedRoute = resolveWorktreeOperationRouteForHost(
    {
      ...state,
      worktreesByRepo: selectWorktreesByRepo(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state)
    },
    row.id,
    row.hostId
  )
  return qualifiedRoute && isTabOwnerRoute(directRoute, qualifiedRoute) ? qualifiedRoute : null
}

function isTabOwnerRoute(tab: WorktreeOperationRoute, row: WorktreeOperationRoute): boolean {
  const runtime = runtimeOf(tab)
  if (runtimeOf(row) !== runtime) {
    return false
  }
  // Why: a tab opened through its server names the server, not the SSH machine that server reaches.
  return (
    row.executionHostId === tab.executionHostId ||
    (runtime !== null && tab.executionHostId === toRuntimeExecutionHostId(runtime))
  )
}

/** Tracked and detected rows; rival owners, or none on a pinned tab's route, fail closed. */
export function findCheckRunDetailsWorktree(
  state: AppState,
  file: CheckRunDetailsOwnerFile
): WorktreeOperationOwnerRecord | null {
  // Rebuilt local/direct-SSH views lack provenance; main's published tab still qualifies their owner.
  const tabRoute = hasOpenFileExecutionHostEvidence(file)
    ? getTabRoute(file)
    : getFramedTabRoute(file)
  const rows = [
    ...Object.values(selectWorktreesByRepo(state) ?? {}).flatMap((worktrees) =>
      worktrees.filter((worktree) => worktree.id === file.worktreeId)
    ),
    ...findIndexedDetectedWorktrees(selectDetectedWorktreesByRepo(state), file.worktreeId)
  ]
  const matches = new Map<string, WorktreeOperationOwnerRecord>()
  for (const row of rows) {
    const rowRoute = tabRoute ? getRowRoute(state, row) : null
    if (!tabRoute || (rowRoute && isTabOwnerRoute(tabRoute, rowRoute))) {
      matches.set(
        JSON.stringify([row.repoId, row.hostId ?? null, row.runtimeOwnerEnvironmentId ?? null]),
        row
      )
    }
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null
}
