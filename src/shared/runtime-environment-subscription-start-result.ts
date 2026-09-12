import { RemoteRuntimeClientError } from './remote-runtime-client-error'

// Why: main and preload both speak this IPC return shape; keep the contract
// shared so contextBridge-safe ok-unions cannot drift across the boundary.
export type RuntimeEnvironmentSubscriptionStartResult =
  | { ok: true; subscriptionId: string; requestId: string }
  | {
      ok: false
      error: { code: string; message: string }
    }

export function serializeRuntimeEnvironmentSubscriptionError(error: unknown): {
  code: string
  message: string
} {
  return {
    code: error instanceof RemoteRuntimeClientError ? error.code : 'runtime_error',
    message: error instanceof Error ? error.message : String(error)
  }
}
