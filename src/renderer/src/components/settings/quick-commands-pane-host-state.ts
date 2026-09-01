import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

export function shouldOpenQuickCommandAddIntent(
  addCommandIntentSignal: number | undefined,
  consumedAddIntentSignal: number
): boolean {
  return Boolean(addCommandIntentSignal && consumedAddIntentSignal !== addCommandIntentSignal)
}

export function getAvailableQuickCommandHostId(
  selectedHostId: ExecutionHostId,
  hostOptions: readonly { id: ExecutionHostId }[]
): ExecutionHostId {
  return hostOptions.some((host) => host.id === selectedHostId)
    ? selectedHostId
    : LOCAL_EXECUTION_HOST_ID
}

export function isQuickCommandEditorHostCurrent(
  hostId: ExecutionHostId,
  connectionGeneration: number,
  hostOptions: readonly { id: ExecutionHostId }[],
  runtimeStatuses: ReadonlyMap<string, { connectionGeneration?: number }>
): boolean {
  const host = parseExecutionHostId(hostId)
  return (
    hostOptions.some((option) => option.id === hostId) &&
    (host?.kind !== 'runtime' ||
      (runtimeStatuses.get(host.environmentId)?.connectionGeneration ?? 0) === connectionGeneration)
  )
}

export function shouldShowQuickCommandsRefreshError(
  commandsAreCurrent: boolean,
  runtimeCommands: { error: string | null; ready: boolean } | undefined
): boolean {
  return commandsAreCurrent && runtimeCommands?.ready === true && Boolean(runtimeCommands.error)
}
