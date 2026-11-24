import type * as core from './runtime-environment-ssh-access-operations'
import { submitEnvironmentStoreCommand } from './runtime-environment-store-worker-client'

export async function prepareRuntimeEnvironmentSshAccessLink(
  ...args: Parameters<typeof core.prepareRuntimeEnvironmentSshAccessLink>
): Promise<ReturnType<typeof core.prepareRuntimeEnvironmentSshAccessLink>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'prepareRuntimeEnvironmentSshAccessLink',
    args
  })
  if (reply.operation !== 'prepareRuntimeEnvironmentSshAccessLink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function linkVerifiedRuntimeEnvironmentSshAccess(
  ...args: Parameters<typeof core.linkVerifiedRuntimeEnvironmentSshAccess>
): Promise<ReturnType<typeof core.linkVerifiedRuntimeEnvironmentSshAccess>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'linkVerifiedRuntimeEnvironmentSshAccess',
    args
  })
  if (reply.operation !== 'linkVerifiedRuntimeEnvironmentSshAccess') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function prepareRuntimeEnvironmentSshAccessUnlink(
  ...args: Parameters<typeof core.prepareRuntimeEnvironmentSshAccessUnlink>
): Promise<ReturnType<typeof core.prepareRuntimeEnvironmentSshAccessUnlink>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'prepareRuntimeEnvironmentSshAccessUnlink',
    args
  })
  if (reply.operation !== 'prepareRuntimeEnvironmentSshAccessUnlink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function completeRuntimeEnvironmentSshAccessUnlink(
  ...args: Parameters<typeof core.completeRuntimeEnvironmentSshAccessUnlink>
): Promise<ReturnType<typeof core.completeRuntimeEnvironmentSshAccessUnlink>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'completeRuntimeEnvironmentSshAccessUnlink',
    args
  })
  if (reply.operation !== 'completeRuntimeEnvironmentSshAccessUnlink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}

export async function cancelRuntimeEnvironmentSshAccessLink(
  ...args: Parameters<typeof core.cancelRuntimeEnvironmentSshAccessLink>
): Promise<ReturnType<typeof core.cancelRuntimeEnvironmentSshAccessLink>> {
  const reply = await submitEnvironmentStoreCommand({
    operation: 'cancelRuntimeEnvironmentSshAccessLink',
    args
  })
  if (reply.operation !== 'cancelRuntimeEnvironmentSshAccessLink') {
    throw new Error('Unexpected environment store response')
  }
  return reply.value
}
