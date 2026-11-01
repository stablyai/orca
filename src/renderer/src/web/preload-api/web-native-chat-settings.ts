import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { runtimeChatPermissionSetting } from './web-preference-normalization'
import { callEnvironmentEnvelope } from './web-runtime-calls'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { zcodePlanSiteOwner } from './web-zcode-plan-site'

let consent: { owner: string | null; value: boolean | undefined } | undefined

export const read = runtimeChatPermissionSetting

export function publish(
  environment: StoredWebRuntimeEnvironment,
  settings: Partial<GlobalSettings>
): void {
  const owner = zcodePlanSiteOwner(environment)
  if (owner === zcodePlanSiteOwner(requireActiveEnvironmentOrNull())) {
    consent = {
      owner,
      value:
        typeof settings.nativeChatAutoContinueAfterUsageLimit === 'boolean'
          ? settings.nativeChatAutoContinueAfterUsageLimit
          : undefined
    }
  }
}

export function project(settings: GlobalSettings): GlobalSettings {
  const environment = requireActiveEnvironmentOrNull()
  return {
    ...settings,
    nativeChatAutoContinueAfterUsageLimit:
      consent?.owner === zcodePlanSiteOwner(environment) ? consent?.value : undefined
  }
}

export async function call<T>(
  environment: StoredWebRuntimeEnvironment,
  method: string,
  params?: unknown
): Promise<T> {
  const response = await callEnvironmentEnvelope<T>(
    environment.id,
    method,
    params,
    15_000,
    environment.pairingRevision ?? environment.createdAt
  )
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

export async function updates(
  settings: Partial<GlobalSettings>,
  environment: StoredWebRuntimeEnvironment
): Promise<Partial<GlobalSettings>> {
  const result = runtimeChatPermissionSetting(settings, false)
  if (typeof settings.nativeChatAutoContinueAfterUsageLimit === 'boolean') {
    const status = await call<RuntimeStatus>(environment, 'status.get')
    if (status.capabilities?.includes(AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY)) {
      return {
        ...result,
        nativeChatAutoContinueAfterUsageLimit: settings.nativeChatAutoContinueAfterUsageLimit
      }
    }
  }
  return result
}
