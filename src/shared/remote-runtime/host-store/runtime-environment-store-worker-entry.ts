import { parentPort } from 'node:worker_threads'
import { setSecurePathHardeningReporter } from '../../secure-storage/secure-path-hardening-report'
import { setEnvironmentStoreWarningSink } from './runtime-environment-store-records'
import { runEnvironmentStoreBatch } from './runtime-environment-store-batch'
import type { EnvironmentStoreRequest } from './runtime-environment-store-worker-protocol'

if (!parentPort) {
  throw new Error('Environment store worker requires a parent')
}
const port = parentPort
setSecurePathHardeningReporter((entry) => port.postMessage({ kind: 'hardening', entry }))
setEnvironmentStoreWarningSink((message) => port.postMessage({ kind: 'warning', message }))
port.on('message', (request: EnvironmentStoreRequest) => {
  port.postMessage(runEnvironmentStoreBatch(request))
})
