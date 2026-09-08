import type { ExecutionHostId } from '../../../../shared/execution-host'

export const WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT = 'orca:workspace-multiplexer-add-request'

export type WorkspaceMultiplexerAddRequestDetail = {
  worktreeId: string
  executionHostId?: ExecutionHostId
}

export function requestWorkspaceMultiplexerAdd(detail: WorkspaceMultiplexerAddRequestDetail): void {
  window.dispatchEvent(
    new CustomEvent<WorkspaceMultiplexerAddRequestDetail>(WORKSPACE_MULTIPLEXER_ADD_REQUEST_EVENT, {
      detail
    })
  )
}
