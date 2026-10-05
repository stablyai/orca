import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export const LOCAL_STRUCTURED_SESSION_OWNER = 'local-structured-session'

/** The host a session-tabs mirror owner publishes for: this machine, or a paired environment. */
export function executionHostIdForSessionTabsOwner(owner: string): ExecutionHostId {
  return owner === LOCAL_STRUCTURED_SESSION_OWNER
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(owner)
}
