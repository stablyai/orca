import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'

export type WebSessionIntentOwner = {
  environmentId: string
  pairingRevision?: number
}

export function webSessionIntentOwnerKey(owner: WebSessionIntentOwner): string {
  const environmentId = owner.environmentId.trim()
  const pairingRevision =
    owner.pairingRevision ?? getRuntimeEnvironmentRevision(environmentId) ?? null
  return JSON.stringify([environmentId, pairingRevision])
}
