import { resolveBrowserLinkSession } from './browser-link-session'
import { activateAndRevealWorkspace } from './worktree-activation'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import type { WorkspaceFilePreviewPlan } from './file-preview'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import { openLocalBrowserLink } from './browser-link-open'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { selectDetectedWorktreesByRepo } from '@/store/workspace-record-selectors'
import { hasIndexedDetectedWorktree } from './worktree-runtime-owner-index'

export type FileBrowserLinkTarget = {
  filePath: string
  worktreeId: string
  fileExecutionHostId?: ExecutionHostId
}

function resolveFileBrowserLinkExecutionHostId(
  state: AppState,
  worktreeId: string
): ExecutionHostId | null {
  const executionHostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (
    executionHostId ||
    !hasIndexedDetectedWorktree(selectDetectedWorktreesByRepo(state), worktreeId)
  ) {
    return executionHostId
  }
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  // A retained active host selection alone cannot prove a detected file's current owner.
  return route?.executionHostId && state.getKnownWorktreeById(worktreeId, route.executionHostId)
    ? route.executionHostId
    : null
}

export async function openPlannedFileBrowserLink(
  state: AppState,
  params: FileBrowserLinkTarget,
  plan: Exclude<WorkspaceFilePreviewPlan, { status: 'unsupported' }>,
  context: BrowserLinkOpenContext,
  ownsPreviewRoute: (state: AppState) => boolean
): Promise<BrowserOpenOutcome> {
  const executionHostId = resolveFileBrowserLinkExecutionHostId(state, params.worktreeId)
  if (
    !executionHostId ||
    (params.fileExecutionHostId &&
      !createBrowserLinkHostMatcher(
        state,
        params.worktreeId,
        executionHostId
      )(params.fileExecutionHostId))
  ) {
    return { status: 'refused' }
  }
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  return openLocalBrowserLink({
    context,
    destination: {
      worktreeId: params.worktreeId,
      executionHostId,
      browserRuntimeEnvironmentId: null,
      profileHostId: LOCAL_EXECUTION_HOST_ID,
      ...resolveBrowserLinkSession(state, params.worktreeId, LOCAL_EXECUTION_HOST_ID),
      resource:
        plan.status === 'doc-preview'
          ? { kind: 'document', docLocation }
          : { kind: 'local-file', url: plan.url }
    },
    url: plan.status === 'doc-preview' ? ORCA_BROWSER_BLANK_URL : plan.url,
    options: plan.status === 'doc-preview' ? { docLocation } : { title: plan.title },
    reveal: () => {
      activateAndRevealWorkspace(params.worktreeId, {
        providesInitialSurface: true,
        executionHostId
      })
    },
    ownsRoute: (current) =>
      resolveFileBrowserLinkExecutionHostId(current, params.worktreeId) === executionHostId &&
      ownsPreviewRoute(current)
  })
}
