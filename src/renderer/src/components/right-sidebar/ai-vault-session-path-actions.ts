import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export function canUseLocalAiVaultSessionPathActions(
  executionHostId: ExecutionHostId | null | undefined
): boolean {
  // Why: Electron shell open/reveal APIs only validate paths on this computer;
  // SSH session history exposes paths that exist on the remote host instead.
  return normalizeExecutionHostId(executionHostId) === LOCAL_EXECUTION_HOST_ID
}
