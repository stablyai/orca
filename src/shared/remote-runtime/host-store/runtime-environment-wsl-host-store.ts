import type * as core from './runtime-environment-wsl-host-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

export async function findWslHostDeployment(
  ...args: Parameters<typeof core.findWslHostDeployment>
): Promise<ReturnType<typeof core.findWslHostDeployment>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'findWslHostDeployment', args })
  if (reply.operation !== 'findWslHostDeployment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function addWslHostEnvironment(
  ...args: Parameters<typeof core.addWslHostEnvironment>
): Promise<ReturnType<typeof core.addWslHostEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'addWslHostEnvironment', args })
  if (reply.operation !== 'addWslHostEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function refreshWslHostPairing(
  ...args: Parameters<typeof core.refreshWslHostPairing>
): Promise<ReturnType<typeof core.refreshWslHostPairing>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'refreshWslHostPairing', args })
  if (reply.operation !== 'refreshWslHostPairing') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function reconcileWslHostBridgePorts(
  ...args: Parameters<typeof core.reconcileWslHostBridgePorts>
): Promise<ReturnType<typeof core.reconcileWslHostBridgePorts>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'reconcileWslHostBridgePorts',
    args
  })
  if (reply.operation !== 'reconcileWslHostBridgePorts') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function setWslHostPendingStop(
  ...args: Parameters<typeof core.setWslHostPendingStop>
): Promise<ReturnType<typeof core.setWslHostPendingStop>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'setWslHostPendingStop', args })
  if (reply.operation !== 'setWslHostPendingStop') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function removeWslHostEnvironment(
  ...args: Parameters<typeof core.removeWslHostEnvironment>
): Promise<ReturnType<typeof core.removeWslHostEnvironment>> {
  const reply = await submitEnvironmentStoreCommand({ operation: 'removeWslHostEnvironment', args })
  if (reply.operation !== 'removeWslHostEnvironment') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
