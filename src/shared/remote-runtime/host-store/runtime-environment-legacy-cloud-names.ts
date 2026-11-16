import type * as core from './runtime-environment-legacy-cloud-names-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

export async function renameLegacyOrcaCloudEnvironmentNames(
  ...args: Parameters<typeof core.renameLegacyOrcaCloudEnvironmentNames>
): Promise<ReturnType<typeof core.renameLegacyOrcaCloudEnvironmentNames>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'renameLegacyOrcaCloudEnvironmentNames',
    args
  })
  if (reply.operation !== 'renameLegacyOrcaCloudEnvironmentNames') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
