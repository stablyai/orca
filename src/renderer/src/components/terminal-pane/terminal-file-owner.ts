import {
  findWorkspaceFileRoute,
  type ResolvedWorkspaceFileRoute
} from '@/lib/runtime-workspace-file-route'
import { buildWorkspaceFileContext } from '@/lib/workspace-file-host-routing'
import { getActiveRuntimeTarget, settingsForRuntimeOwner } from '@/runtime/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { getRemoteFileArgs } from '@/runtime/runtime-file-routing'
import { useAppStore } from '@/store'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'

export type TerminalFileOwner =
  | { kind: 'workspace'; fileContext: RuntimeFileOperationArgs }
  | {
      kind: 'runtime-sibling'
      fileContext: RuntimeFileOperationArgs
      route: ResolvedWorkspaceFileRoute
    }
  | {
      kind: 'client'
      fileContext: RuntimeFileOperationArgs
      /** Host of the pane's own workspace, which still hosts the tab showing this file. */
      paneExecutionHostId: ExecutionHostId
    }

/**
 * Which host owns a path printed in a workspace pane. A runtime serves files only inside its
 * workspaces, so a path outside the pane's own belongs to a sibling workspace on that runtime,
 * or else to this client — the same machine link detection probes for it.
 */
export function resolveTerminalFileOwner(
  worktreeId: string,
  worktreePath: string,
  runtimeEnvironmentId: string | null | undefined,
  filePath: string
): TerminalFileOwner {
  const fileContext = buildWorkspaceFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
  const target = getActiveRuntimeTarget(fileContext.settings)
  if (
    target.kind !== 'environment' ||
    !fileContext.worktreeId ||
    // Why: an SSH-backed runtime repo's outside paths live on that SSH host, not this client.
    fileContext.connectionId ||
    getRemoteFileArgs(fileContext, filePath)
  ) {
    return { kind: 'workspace', fileContext }
  }
  const route = findWorkspaceFileRoute(
    useAppStore.getState(),
    toRuntimeExecutionHostId(target.environmentId),
    filePath
  )
  if (route) {
    return {
      kind: 'runtime-sibling',
      route,
      fileContext: buildWorkspaceFileContext(route.worktreeId, route.rootPath, target.environmentId)
    }
  }
  return {
    kind: 'client',
    fileContext: { ...fileContext, settings: settingsForRuntimeOwner(fileContext.settings, null) },
    paneExecutionHostId: toRuntimeExecutionHostId(target.environmentId)
  }
}
