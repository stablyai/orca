import type * as core from './runtime-environment-store-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

export async function listEnvironments(
  ...args: Parameters<typeof core.listEnvironments>
): Promise<ReturnType<typeof core.listEnvironments>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'listEnvironments', args })
  if (reply.operation !== 'listEnvironments') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function addEnvironmentFromPairingCode(
  ...args: Parameters<typeof core.addEnvironmentFromPairingCode>
): Promise<ReturnType<typeof core.addEnvironmentFromPairingCode>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'addEnvironmentFromPairingCode',
    args
  })
  if (reply.operation !== 'addEnvironmentFromPairingCode') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function addOrUpdateEnvironmentFromPairingCode(
  ...args: Parameters<typeof core.addOrUpdateEnvironmentFromPairingCode>
): Promise<ReturnType<typeof core.addOrUpdateEnvironmentFromPairingCode>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'addOrUpdateEnvironmentFromPairingCode',
    args
  })
  if (reply.operation !== 'addOrUpdateEnvironmentFromPairingCode') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function parseRemotePairingCode(
  ...args: Parameters<typeof core.parseRemotePairingCode>
): Promise<ReturnType<typeof core.parseRemotePairingCode>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'parseRemotePairingCode', args })
  if (reply.operation !== 'parseRemotePairingCode') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function removeEnvironment(
  ...args: Parameters<typeof core.removeEnvironment>
): Promise<ReturnType<typeof core.removeEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'removeEnvironment', args })
  if (reply.operation !== 'removeEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function updateEnvironmentFromPairingCode(
  ...args: Parameters<typeof core.updateEnvironmentFromPairingCode>
): Promise<ReturnType<typeof core.updateEnvironmentFromPairingCode>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'updateEnvironmentFromPairingCode',
    args
  })
  if (reply.operation !== 'updateEnvironmentFromPairingCode') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function replaceEnvironmentPairing(
  ...args: Parameters<typeof core.replaceEnvironmentPairing>
): Promise<ReturnType<typeof core.replaceEnvironmentPairing>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'replaceEnvironmentPairing',
    args
  })
  if (reply.operation !== 'replaceEnvironmentPairing') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
export { getPairingConnectionDependency } from './runtime-environment-selection'

export async function resolveEnvironment(
  ...args: Parameters<typeof core.resolveEnvironment>
): Promise<ReturnType<typeof core.resolveEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'resolveEnvironment', args })
  if (reply.operation !== 'resolveEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function resolveEnvironmentPairingOffer(
  ...args: Parameters<typeof core.resolveEnvironmentPairingOffer>
): Promise<ReturnType<typeof core.resolveEnvironmentPairingOffer>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'resolveEnvironmentPairingOffer',
    args
  })
  if (reply.operation !== 'resolveEnvironmentPairingOffer') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function markEnvironmentUsed(
  ...args: Parameters<typeof core.markEnvironmentUsed>
): Promise<ReturnType<typeof core.markEnvironmentUsed>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'markEnvironmentUsed', args })
  if (reply.operation !== 'markEnvironmentUsed') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
export { resolveEnvironmentFromStore } from './runtime-environment-selection'
export type { AddEnvironmentArgs } from './runtime-environment-store-operations'
export type { AddEnvironmentOutcome } from './runtime-environment-store-operations'
