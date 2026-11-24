import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'
import type * as readEnvironmentStoreRecordsCore from './runtime-environment-store-records'
export async function readEnvironmentStoreRecords(
  ...args: Parameters<typeof readEnvironmentStoreRecordsCore.readEnvironmentStoreRecords>
): Promise<ReturnType<typeof readEnvironmentStoreRecordsCore.readEnvironmentStoreRecords>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'readEnvironmentStoreRecords',
    args
  })
  if (reply.operation !== 'readEnvironmentStoreRecords') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
import type * as readWslHostDeploymentsCore from './wsl-host-deployment-store'
export async function readWslHostDeployments(
  ...args: Parameters<typeof readWslHostDeploymentsCore.readWslHostDeployments>
): Promise<ReturnType<typeof readWslHostDeploymentsCore.readWslHostDeployments>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'readWslHostDeployments', args })
  if (reply.operation !== 'readWslHostDeployments') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
