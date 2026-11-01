import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

/** Local setup facts; remote protocol and saved host records do not carry them. */
type SetupFact =
  | { kind: 'cancelled' | 'source-retired' | 'manual-disconnect' | 'input' | 'host-unsupported' }
  | { kind: 'remote'; code: string }
  | {
      kind: 'operation'
      operation: 'environment-resolution' | 'subscription'
    }

export type CrewSetupFact = Readonly<SetupFact>

export type CrewSubscriptionSetupResult =
  | { subscriptionId: string; ok: true }
  | {
      subscriptionId: string
      ok: false
      failure: { message: string; code?: string; fact: CrewSetupFact }
    }

export type CrewSubscriptionAttemptArgs = {
  subscriptionId: string
  selector: string
  method: 'orchestration.crewSubscribe'
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision: number
  expectedEnvironmentRuntimeId: string | null
}

/** A fresh guard's fact belongs to that occurrence, never to a reused external Error. */
export class RuntimeEnvironmentSetupGuardError extends Error {
  constructor(
    message: string,
    readonly setupFact: CrewSetupFact
  ) {
    super(message)
  }
}

export type RuntimeEnvironmentSetupFailure = Readonly<{
  error: unknown
  fact: CrewSetupFact
}>

export function runtimeEnvironmentSetupFailure(
  error: unknown,
  operation: Extract<CrewSetupFact, { kind: 'operation' }>['operation']
): RuntimeEnvironmentSetupFailure {
  return {
    error,
    fact:
      error instanceof RuntimeEnvironmentSetupGuardError
        ? error.setupFact
        : { kind: 'operation', operation }
  }
}

export type CrewSubscriptionAttemptCallbacks = {
  onResponse: (response: RuntimeRpcResponse<unknown>) => void
  onError?: (error: { code: string; message: string }) => void
  onClose?: () => void
}

export function isCrewSetupFact(value: unknown): value is CrewSetupFact {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false
  }
  switch (value.kind) {
    case 'cancelled':
    case 'source-retired':
    case 'manual-disconnect':
    case 'input':
    case 'host-unsupported':
      return true
    case 'remote':
      return 'code' in value && typeof value.code === 'string'
    case 'operation':
      return (
        'operation' in value &&
        (value.operation === 'environment-resolution' || value.operation === 'subscription')
      )
    default:
      return false
  }
}
