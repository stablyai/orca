import { parentPort } from 'node:worker_threads'
import { setSecurePathHardeningReporter } from '../../secure-storage/secure-path-hardening-report'
import {
  ignoreInheritedWslHostsGateState,
  noteWslHostsPolicyBlocked,
  noteWslHostsServeOnly
} from '../../wsl-host-internal-gate'
import { executeEnvironmentStoreCommand } from './runtime-environment-store-command'
import {
  withEnvironmentStoreObservation,
  invalidateEnvironmentStoreObservation
} from './runtime-environment-store-observation'
import { environmentStoreWriteCount } from './runtime-environment-store-file'
import { setEnvironmentStoreWarningSink } from './runtime-environment-store-records'
import type {
  EnvironmentStoreError,
  EnvironmentStoreRequest,
  EnvironmentStoreResponse
} from './runtime-environment-store-worker-protocol'

if (!parentPort) {
  throw new Error('Environment store worker requires a parent')
}
const port = parentPort
setSecurePathHardeningReporter((entry) => port.postMessage({ kind: 'hardening', entry }))
setEnvironmentStoreWarningSink((message) => port.postMessage({ kind: 'warning', message }))
port.on('message', (request: EnvironmentStoreRequest) => {
  ignoreInheritedWslHostsGateState()
  noteWslHostsPolicyBlocked(!request.servingWsl)
  noteWslHostsServeOnly(request.servingWsl)
  const response: EnvironmentStoreResponse = withEnvironmentStoreObservation(() => ({
    kind: 'response',
    id: request.id,
    writes: 0,
    results: request.commands.map((command) => {
      try {
        return { ok: true as const, result: executeEnvironmentStoreCommand(command) }
      } catch (cause) {
        invalidateEnvironmentStoreObservation()
        const error = cause instanceof Error ? cause : new Error(String(cause))
        const fields = error as Error & Partial<EnvironmentStoreError>
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
  }))
  response.writes = environmentStoreWriteCount()
  port.postMessage(response)
})
