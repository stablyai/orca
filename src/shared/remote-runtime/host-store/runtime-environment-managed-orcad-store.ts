import type * as core from './runtime-environment-managed-orcad-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

export async function addManagedOrcadEnvironment(
  ...args: Parameters<typeof core.addManagedOrcadEnvironment>
): Promise<ReturnType<typeof core.addManagedOrcadEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'addManagedOrcadEnvironment',
    args
  })
  if (reply.operation !== 'addManagedOrcadEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function removeManagedOrcadEnvironment(
  ...args: Parameters<typeof core.removeManagedOrcadEnvironment>
): Promise<ReturnType<typeof core.removeManagedOrcadEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'removeManagedOrcadEnvironment',
    args
  })
  if (reply.operation !== 'removeManagedOrcadEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function refreshManagedOrcadPairing(
  ...args: Parameters<typeof core.refreshManagedOrcadPairing>
): Promise<ReturnType<typeof core.refreshManagedOrcadPairing>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'refreshManagedOrcadPairing',
    args
  })
  if (reply.operation !== 'refreshManagedOrcadPairing') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function moveManagedOrcadLocalPort(
  ...args: Parameters<typeof core.moveManagedOrcadLocalPort>
): Promise<ReturnType<typeof core.moveManagedOrcadLocalPort>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'moveManagedOrcadLocalPort',
    args
  })
  if (reply.operation !== 'moveManagedOrcadLocalPort') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function recordManagedOrcadMigration(
  ...args: Parameters<typeof core.recordManagedOrcadMigration>
): Promise<ReturnType<typeof core.recordManagedOrcadMigration>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'recordManagedOrcadMigration',
    args
  })
  if (reply.operation !== 'recordManagedOrcadMigration') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
