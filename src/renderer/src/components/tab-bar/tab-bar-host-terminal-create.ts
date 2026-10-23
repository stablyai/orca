import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import {
  isTerminalCreatedHere,
  type RuntimeTerminalCreate
} from '../../../../shared/runtime-terminal-contracts'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { isPositivelyLocalSourceWorktree } from '@/lib/terminal-worktree-route'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '../../store'
import { commitTerminalSurfaceClose } from '../../store/terminals/terminal-surface-close-intent'

export type HostTerminalRefusal = {
  code: 'source_worktree_not_local' | 'create_failed' | 'invalid_host_reply'
  executionHostId: ExecutionHostId
  runtimeCode?: string | null
  data?: unknown
}
export type HostTerminalCreateResult =
  | { status: 'created'; tabId: string }
  | { status: 'refused'; refusal: HostTerminalRefusal }

export async function createTerminalTabOnHost({
  worktreeId,
  groupId,
  executionHostId,
  projectHostSetupId
}: {
  worktreeId: string
  groupId: string
  executionHostId: ExecutionHostId
  projectHostSetupId: string
}): Promise<HostTerminalCreateResult> {
  const sourceIsLocal = () => isPositivelyLocalSourceWorktree(useAppStore.getState(), worktreeId)
  const sourceRefusal: HostTerminalCreateResult = {
    status: 'refused',
    refusal: { code: 'source_worktree_not_local', executionHostId }
  }
  if (!sourceIsLocal()) {
    return sourceRefusal
  }
  const tabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  let created: RuntimeTerminalCreate
  try {
    const reply = await callRuntimeRpc<{ terminal: RuntimeTerminalCreate }>(
      { kind: 'local' },
      'terminal.create',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        executionHostId,
        projectHostSetupId,
        presentation: 'background',
        tabId,
        leafId,
        groupId
      }
    )
    created = reply.terminal
  } catch (error) {
    const rpcError = error instanceof RuntimeRpcCallError ? error : null
    return {
      status: 'refused',
      refusal: {
        code: 'create_failed',
        executionHostId,
        runtimeCode: rpcError?.code ?? null,
        data: rpcError?.response.error.data ?? null
      }
    }
  }
  const target = parseExecutionHostId(executionHostId)
  if (
    target?.kind !== 'runtime' ||
    created.executionHostId !== executionHostId ||
    created.ptyId !== toRemoteRuntimePtyId(created.handle, target.environmentId)
  ) {
    commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId }, 'cleanup')
    return { status: 'refused', refusal: { code: 'invalid_host_reply', executionHostId } }
  }
  const state = useAppStore.getState()
  const tabOptions = {
    id: tabId,
    initialLeafId: leafId,
    initialPtyId: created.ptyId ?? undefined,
    executionHostId,
    projectHostSetupId
  }
  if (!sourceIsLocal()) {
    if (isTerminalCreatedHere(created)) {
      state.createTab(worktreeId, groupId, undefined, { ...tabOptions, activate: false })
      useAppStore.getState().closeTab(tabId, { reason: 'cleanup', captureRecentlyClosed: false })
    } else {
      commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId }, 'cleanup')
    }
    return sourceRefusal
  }
  const terminal = state.createTab(worktreeId, groupId, undefined, tabOptions)
  state.setActiveTab(terminal.id)
  state.setActiveTabType('terminal', worktreeId)
  focusTerminalTabSurface(terminal.id)
  return { status: 'created', tabId: terminal.id }
}
