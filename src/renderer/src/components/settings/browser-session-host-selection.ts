import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'

export function resolveAvailableBrowserSessionHostId(
  options: readonly { id: ExecutionHostId }[],
  overrideHostId: ExecutionHostId | null,
  focusedHostId: ExecutionHostId
): ExecutionHostId {
  const availableIds = new Set(options.map((option) => option.id))
  if (overrideHostId && availableIds.has(overrideHostId)) {
    return overrideHostId
  }
  if (availableIds.has(focusedHostId)) {
    return focusedHostId
  }
  return options[0]?.id ?? LOCAL_EXECUTION_HOST_ID
}
