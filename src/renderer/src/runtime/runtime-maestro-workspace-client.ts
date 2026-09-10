import { MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type {
  RuntimeMaestroWorkspaceContentReadResult,
  RuntimeMaestroWorkspaceCanvasMutation,
  RuntimeMaestroWorkspaceCanvasMutationResult,
  RuntimeMaestroWorkspaceCanvasQueryResult,
  RuntimeMaestroWorkspaceCanvasScope
} from '../../../shared/runtime-types'
import type { RuntimeMarkdownReadTabResult } from '../../../shared/mobile-markdown-document'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { WorkspaceSurfaceId } from '../../../shared/maestro-workspace-canvas'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import type { RuntimeClientTarget } from './runtime-client-target'

async function supportsWorkspaceCanvas(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'environment') {
    return runtimeEnvironmentSupportsCapability(
      target.environmentId,
      MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY
    )
  }
  const status = await window.api.runtime.getStatus()
  return status.capabilities?.includes(MAESTRO_WORKSPACE_CANVAS_RUNTIME_CAPABILITY) === true
}

export async function getRuntimeMaestroWorkspaceCanvas(
  target: RuntimeClientTarget,
  scope: RuntimeMaestroWorkspaceCanvasScope
): Promise<RuntimeMaestroWorkspaceCanvasQueryResult> {
  try {
    if (!(await supportsWorkspaceCanvas(target))) {
      return { status: 'unavailable', reason: 'update-required', liveness: 'unverifiable' }
    }
    return await callRuntimeRpc(target, 'maestro.workspaceCanvas.get', scope)
  } catch {
    return { status: 'unavailable', reason: 'authority-unreachable', liveness: 'unverifiable' }
  }
}

export async function mutateRuntimeMaestroWorkspaceCanvas(
  target: RuntimeClientTarget,
  mutation: RuntimeMaestroWorkspaceCanvasMutation
): Promise<RuntimeMaestroWorkspaceCanvasMutationResult> {
  try {
    if (!(await supportsWorkspaceCanvas(target))) {
      return {
        status: 'unavailable',
        authority_revision: mutation.expected_authority_revision,
        reason: 'update-required',
        liveness: 'unverifiable'
      }
    }
    return await callRuntimeRpc(target, 'maestro.workspaceCanvas.mutate', mutation)
  } catch (error) {
    return {
      status: 'outcome_unknown',
      authority_revision: mutation.expected_authority_revision,
      reason: error instanceof Error ? error.message : 'workspace_canvas_mutation_failed',
      liveness: 'unverifiable'
    }
  }
}

export function readRuntimeMaestroAnnotation(
  target: RuntimeClientTarget,
  worktreeId: string,
  tabId: string
): Promise<RuntimeMarkdownReadTabResult> {
  return callRuntimeRpc(target, 'markdown.readTab', { worktree: `id:${worktreeId}`, tabId })
}

export function readRuntimeMaestroContent(
  target: RuntimeClientTarget,
  scope: RuntimeMaestroWorkspaceCanvasScope,
  surfaceId: WorkspaceSurfaceId
): Promise<RuntimeMaestroWorkspaceContentReadResult> {
  return callRuntimeRpc(target, 'maestro.workspaceCanvas.readContent', {
    scope,
    surface_id: surfaceId
  })
}

export function readRuntimeMaestroDiff(
  target: RuntimeClientTarget,
  worktreeId: string,
  relativePath: string,
  staged: boolean
): Promise<GitDiffResult> {
  return callRuntimeRpc(target, 'git.diff', {
    worktree: `id:${worktreeId}`,
    filePath: relativePath,
    staged
  })
}
