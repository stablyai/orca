import type { FolderWorkspace } from '../../../../../shared/folder-workspace-types'
import {
  MULTI_REPO_WORKSPACE_ERROR_CODES,
  MultiRepoWorkspaceError,
  type MultiRepoDeleteInspection,
  type MultiRepoDeleteResult,
  type MultiRepoWorkspaceErrorCode
} from '../../../../../shared/multi-repo-workspace'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { PreloadApi } from '../../../../../preload/api-types'
import { callRuntimeRpc } from '../../../runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '../../../runtime/runtime-rpc-result'

type MultiRepoApi = PreloadApi['multiRepoWorkspaces']

export type MultiRepoWorkspaceCreateArgs = Parameters<MultiRepoApi['create']>[0]
export type MultiRepoMemberArgs = Parameters<MultiRepoApi['retryMember']>[0]
export type MultiRepoWorkspaceDeleteArgs = Parameters<MultiRepoApi['delete']>[0]
type FolderWorkspaceReply = { folderWorkspace: FolderWorkspace }

export type MultiRepoWorkspaceCalls = {
  create: { params: MultiRepoWorkspaceCreateArgs; result: FolderWorkspaceReply }
  retryMember: { params: MultiRepoMemberArgs; result: FolderWorkspaceReply }
  removeMember: { params: MultiRepoMemberArgs; result: FolderWorkspaceReply }
  detachMember: { params: MultiRepoMemberArgs; result: FolderWorkspaceReply }
  attachMember: { params: MultiRepoMemberArgs; result: FolderWorkspaceReply }
  inspectDelete: { params: { folderWorkspaceId: string }; result: MultiRepoDeleteInspection }
  delete: { params: MultiRepoWorkspaceDeleteArgs; result: MultiRepoDeleteResult }
}

export type MultiRepoWorkspaceMethod = keyof MultiRepoWorkspaceCalls

const LOCAL_ERROR_PATTERN = /(multi_repo_[a-z_]+): ([\s\S]*)$/

// Methods that mutate or create get a longer budget than a read-only preflight.
const RPC_TIMEOUT_MS: Record<MultiRepoWorkspaceMethod, number> = {
  create: 30_000,
  retryMember: 120_000,
  removeMember: 15_000,
  detachMember: 15_000,
  attachMember: 15_000,
  inspectDelete: 30_000,
  delete: 120_000
}

function toErrorCode(value: string): MultiRepoWorkspaceErrorCode | null {
  return MULTI_REPO_WORKSPACE_ERROR_CODES.find((code) => code === value) ?? null
}

export function parseMultiRepoWorkspaceError(error: unknown): MultiRepoWorkspaceError | null {
  if (error instanceof MultiRepoWorkspaceError) {
    return error
  }
  if (error instanceof RuntimeRpcCallError) {
    const code = toErrorCode(error.code)
    if (code) {
      return new MultiRepoWorkspaceError(code, error.message)
    }
    if (error.code === 'method_not_found' || error.code === 'rpc_method_not_found') {
      return new MultiRepoWorkspaceError('multi_repo_capability_unsupported', error.message)
    }
    return null
  }
  const message = error instanceof Error ? error.message : ''
  const match = LOCAL_ERROR_PATTERN.exec(message)
  const code = match ? toErrorCode(match[1]) : null
  return code && match ? new MultiRepoWorkspaceError(code, match[2]) : null
}

function callLocal<M extends MultiRepoWorkspaceMethod>(
  method: M,
  params: MultiRepoWorkspaceCalls[M]['params']
): Promise<MultiRepoWorkspaceCalls[M]['result']> {
  const api = window.api.multiRepoWorkspaces
  const calls: {
    [K in MultiRepoWorkspaceMethod]: (
      p: MultiRepoWorkspaceCalls[K]['params']
    ) => Promise<MultiRepoWorkspaceCalls[K]['result']>
  } = {
    create: api.create,
    retryMember: api.retryMember,
    removeMember: api.removeMember,
    detachMember: api.detachMember,
    attachMember: api.attachMember,
    inspectDelete: api.inspectDelete,
    delete: api.delete
  }
  return calls[method](params)
}

export async function callMultiRepoWorkspace<M extends MultiRepoWorkspaceMethod>(
  target: RuntimeClientTarget,
  method: M,
  params: MultiRepoWorkspaceCalls[M]['params']
): Promise<MultiRepoWorkspaceCalls[M]['result']> {
  try {
    return target.kind === 'local'
      ? await callLocal(method, params)
      : await callRuntimeRpc<MultiRepoWorkspaceCalls[M]['result']>(
          target,
          `multiRepoWorkspace.${method}`,
          params,
          { timeoutMs: RPC_TIMEOUT_MS[method] }
        )
  } catch (error) {
    throw parseMultiRepoWorkspaceError(error) ?? error
  }
}
