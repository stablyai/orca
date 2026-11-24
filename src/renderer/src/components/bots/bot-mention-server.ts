import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

/** The paired server an `@` token names a bot's host by: its id; null for a host that isn't one. */
export function botMentionServer(hostId: ExecutionHostId): string | null {
  const host = parseExecutionHostId(hostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

/** The host a token's server names. */
export function botMentionServerHost(server: string): ExecutionHostId {
  return toRuntimeExecutionHostId(server)
}
