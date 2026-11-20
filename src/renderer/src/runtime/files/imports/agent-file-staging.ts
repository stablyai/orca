import { useAppStore } from '@/store/index'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { DROP_STAGING_RELATIVE_DIR } from '../../../../../shared/file-import/drop-staging-ignore'
import type { ImportSkipReason } from '../../../../../shared/file-import/filesystem-import-result'
import { resolveExactWorktreeRoute } from '@/lib/workspace/ownership/worktree-owner-route'
import { isTerminalDropWindowsPathLike } from '../../../../../shared/terminal/input/image-path-paste'
import { runtimeTargetForOwnerEnvironment } from '../../rpc/targets/runtime-client-target'
import { importExternalPathsToRuntime } from './runtime-file-import-client'
import type { RuntimeImportProgressHandlers } from './runtime-upload-progress-tracker'

export function resolveAgentStagingWorktreePath(
  worktreeId: string,
  fallbackCwd: string | undefined,
  executionHostId: ExecutionHostId | null | undefined,
  runtimeEnvironmentId?: string | null
): string | null {
  const host = parseExecutionHostId(executionHostId)
  if (!host) {
    return null
  }
  const environmentId =
    runtimeEnvironmentId ?? (host.kind === 'runtime' ? host.environmentId : null)
  // A runtime's physical local host is a different catalog namespace from the client's local host.
  const catalogHostId = environmentId ? toRuntimeExecutionHostId(environmentId) : host.id
  const state = useAppStore.getState()
  const worktree = findKnownWorktreeById(state, worktreeId, catalogHostId)
  if (host.kind === 'ssh' && environmentId) {
    const resolution = worktree && resolveExactWorktreeRoute(state, worktree)
    if (
      resolution?.kind !== 'resolved' ||
      resolution.route.runtimeEnvironmentId !== environmentId ||
      resolution.route.executionHostId !== host.id
    ) {
      return null
    }
  } else if (environmentId && parseExecutionHostId(worktree?.hostId)?.kind === 'ssh') {
    return null
  }
  return worktree?.path ?? (catalogHostId === 'local' ? fallbackCwd : null) ?? null
}

/** A worktree on a paired or managed server, where an agent can read `.orca/drops`. */
export type AgentFileStagingTarget = {
  runtimeEnvironmentId: string
  worktreeId: string
  worktreePath: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

export type AgentFileStagingResult = {
  staged: { sourcePath: string; hostPath: string }[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  failed: { sourcePath: string; reason: string }[]
}

/** Copy client files into the worktree's `.orca/drops` on the agent's host; returns paths that host can read. */
export async function stageClientFilesForAgent(
  target: AgentFileStagingTarget,
  sourcePaths: string[],
  assertCurrent?: () => void,
  progress?: RuntimeImportProgressHandlers
): Promise<AgentFileStagingResult> {
  const { worktreePath } = target
  const windowsHost = isTerminalDropWindowsPathLike(worktreePath)
  const dropDir = `${worktreePath.replace(/[\\/]+$/, '')}/${DROP_STAGING_RELATIVE_DIR}`
  const { results } = await importExternalPathsToRuntime(
    {
      target: runtimeTargetForOwnerEnvironment(target.runtimeEnvironmentId),
      worktreeId: target.worktreeId,
      worktreePath,
      expectedExecutionHostId: target.expectedExecutionHostId,
      expectedSshTargetId: target.expectedSshTargetId,
      expectedSshConnectionGeneration: target.expectedSshConnectionGeneration
    },
    sourcePaths,
    windowsHost ? dropDir.replace(/\//g, '\\') : dropDir,
    { assertCurrent, nameExtensionlessImages: true, progress }
  )
  const staged: AgentFileStagingResult = { staged: [], skipped: [], failed: [] }
  for (const result of results) {
    if (result.status === 'imported') {
      staged.staged.push({
        sourcePath: result.sourcePath,
        hostPath: windowsHost ? result.destPath.replace(/\//g, '\\') : result.destPath
      })
    } else if (result.status === 'skipped') {
      staged.skipped.push({ sourcePath: result.sourcePath, reason: result.reason })
    } else if (result.cancelled !== true) {
      // Why: a cancel is the user's own decision, not a failure to report back.
      staged.failed.push({ sourcePath: result.sourcePath, reason: result.reason })
    }
  }
  return staged
}
