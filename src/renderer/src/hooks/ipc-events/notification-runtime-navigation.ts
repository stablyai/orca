import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  activateWebRuntimeSessionTab,
  activateWebRuntimeSessionWorktree
} from '@/runtime/web-runtime-session'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export async function activateNotificationRuntimeTarget(args: {
  executionHostId: ExecutionHostId
  worktreeId: string
  tabId?: string
  leafId?: string
}): Promise<boolean> {
  const host = parseExecutionHostId(args.executionHostId)
  if (host?.kind !== 'runtime') {
    return true
  }
  if (args.tabId) {
    return await activateWebRuntimeSessionTab({
      worktreeId: args.worktreeId,
      tabId: args.tabId,
      ...(args.leafId ? { leafId: args.leafId } : {}),
      environmentId: host.environmentId
    })
  }
  if (parseWorkspaceKey(args.worktreeId)?.type === 'folder') {
    return true
  }
  return await activateWebRuntimeSessionWorktree({
    worktreeId: args.worktreeId,
    environmentId: host.environmentId
  })
}
