import { RuntimeEnvironmentStoreError } from './runtime-environment-store-records'
import { RuntimeEnvironmentSidecarInvalidError } from './runtime-environment-sidecar'
import { WslHostDeploymentStoreInvalidError } from './wsl-host-deployment-store'
import type { EnvironmentStoreError } from './runtime-environment-store-worker-protocol'

export function deserializeEnvironmentStoreError(error: EnvironmentStoreError): Error {
  if (error.name === 'RuntimeEnvironmentStoreError') {
    return new RuntimeEnvironmentStoreError(
      error.code === 'invalid_argument' ? 'invalid_argument' : 'runtime_error',
      error.message,
      error.pairingFailure
    )
  }
  const result = new Error(error.message)
  if (error.name === 'RuntimeEnvironmentSidecarInvalidError') {
    Object.setPrototypeOf(result, RuntimeEnvironmentSidecarInvalidError.prototype)
  } else if (error.name === 'WslHostDeploymentStoreInvalidError') {
    Object.setPrototypeOf(result, WslHostDeploymentStoreInvalidError.prototype)
  }
  result.name = error.name
  if (error.code) {
    Object.assign(result, { code: error.code })
  }
  return result
}
