import { callAbortableRuntimeEnvironment } from './abortable-runtime-environment-call'
import { observePairingRefusal } from '../environment-revisions/runtime-environment-pairing-refresh'

export function callRuntimeEnvironmentWithRevision(
  args: Parameters<typeof callRuntimeEnvironmentOnce>[0]
): Promise<unknown> {
  return observePairingRefusal(callRuntimeEnvironmentOnce(args))
}

async function callRuntimeEnvironmentOnce(args: {
  environmentId: string
  method: string
  params: unknown
  timeoutMs?: number
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
  /** A poll, not the user: no use of an idle WSL host, never a wake of one Orca stopped idle. */
  background?: boolean
  /** The user asked for it: it may wake a WSL host Orca stopped idle. */
  wake?: boolean
}): Promise<unknown> {
  if (args.signal) {
    return callAbortableRuntimeEnvironment(
      args.environmentId,
      args.method,
      args.params,
      args.timeoutMs,
      args.signal,
      args.expectedEnvironmentPairingRevision,
      args.expectedEnvironmentRuntimeId,
      args.background,
      args.wake
    )
  }
  return window.api.runtimeEnvironments.call({
    selector: args.environmentId,
    method: args.method,
    params: args.params,
    timeoutMs: args.timeoutMs,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId: args.expectedEnvironmentRuntimeId,
    ...(args.background ? { background: true } : {}),
    ...(args.wake ? { wake: true } : {})
  })
}
