import { executeEnvironmentStoreCommand } from './runtime-environment-store-command'
import {
  withEnvironmentStoreObservation,
  invalidateEnvironmentStoreObservation
} from './runtime-environment-store-observation'
import { environmentStoreWriteCount } from './runtime-environment-store-file'
import type {
  EnvironmentStoreError,
  EnvironmentStoreRequest,
  EnvironmentStoreResponse
} from './runtime-environment-store-worker-protocol'

export function runEnvironmentStoreBatch(
  request: EnvironmentStoreRequest
): EnvironmentStoreResponse {
  const response: EnvironmentStoreResponse = withEnvironmentStoreObservation(
    () => ({
      kind: 'response',
      id: request.id,
      writes: 0,
      results: request.commands.map((command) => {
        try {
          return { ok: true as const, result: executeEnvironmentStoreCommand(command) }
        } catch (cause) {
          invalidateEnvironmentStoreObservation()
          const error = cause instanceof Error ? cause : new Error(String(cause))
          const fields: Partial<EnvironmentStoreError> = error
          return {
            ok: false as const,
            error: {
              name: error.name,
              message: error.message,
              ...(fields.code ? { code: fields.code } : {}),
              ...(fields.pairingFailure ? { pairingFailure: fields.pairingFailure } : {})
            }
          }
        }
      })
    }),
    request.servingWsl
  )
  response.writes = environmentStoreWriteCount()
  return response
}
