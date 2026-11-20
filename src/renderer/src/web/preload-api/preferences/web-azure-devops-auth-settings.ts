import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { AzureDevOpsAuthMethod } from '../../../../../shared/source-control/azure-devops-auth-types'
import type { StoredWebRuntimeEnvironment } from '../../pairing/web-runtime-environment'
import { callEnvironmentEnvelope } from '../../runtime/client/web-runtime-calls'
import { requireActiveEnvironmentOrNull } from '../../runtime/client/web-runtime-session'
import { unwrapRuntimeRpcResult } from '../../../runtime/rpc/calls/runtime-rpc-result'

type SettingsResult = { settings: Partial<GlobalSettings> }
let confirmed: { owner: string; method: AzureDevOpsAuthMethod } | undefined
let writeGeneration = 0
const confirmedWriteGenerationByOwner = new Map<string, number>()

function ownerOf(
  environment: StoredWebRuntimeEnvironment | null,
  runtimeId = environment?.runtimeId
) {
  return environment && runtimeId
    ? JSON.stringify([
        environment.id,
        environment.pairingRevision ?? environment.createdAt,
        runtimeId
      ])
    : null
}

function publishAzureDevOpsAuthMethod(
  environment: StoredWebRuntimeEnvironment,
  runtimeId: string,
  method: AzureDevOpsAuthMethod | undefined,
  readGeneration?: number
): void {
  const owner = ownerOf(environment, runtimeId)
  if (!owner || owner !== ownerOf(requireActiveEnvironmentOrNull())) {
    return
  }
  if (readGeneration === undefined) {
    confirmedWriteGenerationByOwner.set(owner, ++writeGeneration)
  } else if ((confirmedWriteGenerationByOwner.get(owner) ?? 0) > readGeneration) {
    return
  }
  confirmed = method === 'environment' || method === 'azure-cli' ? { owner, method } : undefined
}

export async function readPairedSettings(
  environment: StoredWebRuntimeEnvironment
): Promise<SettingsResult> {
  // The runtime ID may not be known until the read responds.
  const readGeneration = writeGeneration
  const response = await callEnvironmentEnvelope<SettingsResult>(
    environment.id,
    'settings.get',
    undefined,
    15_000,
    environment.pairingRevision ?? environment.createdAt
  )
  const result = unwrapRuntimeRpcResult(response)
  if (response.ok) {
    publishAzureDevOpsAuthMethod(
      environment,
      response._meta.runtimeId,
      result.settings.azureDevOpsAuthMethod,
      readGeneration
    )
  }
  return result
}

export function readAzureDevOpsAuthMethod(
  environment: StoredWebRuntimeEnvironment | null
): AzureDevOpsAuthMethod | undefined {
  return confirmed?.owner === ownerOf(environment) ? confirmed.method : undefined
}

export async function writeAzureDevOpsAuthMethod(
  method: AzureDevOpsAuthMethod | undefined
): Promise<void> {
  const environment = requireActiveEnvironmentOrNull()
  const owner = ownerOf(environment)
  if (
    !environment?.runtimeId ||
    confirmed?.owner !== owner ||
    (method !== 'environment' && method !== 'azure-cli')
  ) {
    throw new Error('Azure DevOps authentication settings are unavailable on this host')
  }

  const response = await callEnvironmentEnvelope<SettingsResult>(
    environment.id,
    'settings.update',
    { azureDevOpsAuthMethod: method },
    15_000,
    environment.pairingRevision ?? environment.createdAt,
    environment.runtimeId
  )
  const { settings } = unwrapRuntimeRpcResult(response)
  if (
    !response.ok ||
    owner !== ownerOf(requireActiveEnvironmentOrNull()) ||
    settings.azureDevOpsAuthMethod !== method
  ) {
    throw new Error('The active host did not confirm the Azure DevOps authentication method')
  }
  publishAzureDevOpsAuthMethod(environment, response._meta.runtimeId, method)
}
