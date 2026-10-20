import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { normalizeStoredRepositoryAddScript } from '../../../../shared/repository-add-script-settings'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../../shared/repository-add-script-runtime-capabilities'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

export type RepositoryAddScriptSettingOwner = {
  environmentId: string
  pairingRevision?: number
}

export class RepositoryAddScriptSettingUnsupportedError extends Error {
  constructor() {
    super('Update this Orca server to edit its repository add script from here.')
    this.name = 'RepositoryAddScriptSettingUnsupportedError'
  }
}

async function supportsRepositoryAddScript(
  owner: RepositoryAddScriptSettingOwner
): Promise<boolean> {
  return runtimeEnvironmentSupportsCapability(
    owner.environmentId,
    REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY
  )
}

/** The host's script, or null when that server predates the setting and must be updated first. */
export async function readHostRepositoryAddScript(
  owner: RepositoryAddScriptSettingOwner,
  signal?: AbortSignal
): Promise<string | null> {
  if (!(await supportsRepositoryAddScript(owner))) {
    return null
  }
  const result = await callRuntimeRpc<{ settings: GlobalSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.get',
    { includeRepositoryAddScript: true },
    { expectedEnvironmentPairingRevision: owner.pairingRevision, signal, timeoutMs: 15_000 }
  )
  return result.settings.repositoryAddScript ?? ''
}

/** Writes once to the chosen host and returns its normalized echo, or null when the write is unverified. */
export async function writeHostRepositoryAddScript(
  owner: RepositoryAddScriptSettingOwner,
  script: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (!(await supportsRepositoryAddScript(owner))) {
    throw new RepositoryAddScriptSettingUnsupportedError()
  }
  const result = await callRuntimeRpc<{ settings: GlobalSettings }>(
    { kind: 'environment', environmentId: owner.environmentId },
    'settings.update',
    { repositoryAddScript: script, includeRepositoryAddScript: true },
    { expectedEnvironmentPairingRevision: owner.pairingRevision, signal, timeoutMs: 15_000 }
  )
  const echoed = normalizeStoredRepositoryAddScript(result.settings.repositoryAddScript)
  if (typeof echoed === 'string') {
    return echoed
  }
  // Why: an empty script is never echoed back, so only an empty submit proves the write landed.
  return normalizeStoredRepositoryAddScript(script) ? null : ''
}
