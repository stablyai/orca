import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { StoredWebRuntimeEnvironment } from '../../pairing/web-runtime-environment'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { runtimeChatPermissionSetting } from './web-preference-normalization'
import { AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { nativeChatClaudeRemoteControl } from '../../../../../shared/native-chat/settings/native-chat-claude-remote-control'
import { callEnvironmentEnvelope } from '../../runtime/client/web-runtime-calls'
import { requireActiveEnvironmentOrNull } from '../../runtime/client/web-runtime-session'
import { zcodePlanSiteOwner } from './web-zcode-plan-site'

let consent: { owner: string | null; value: boolean | undefined } | undefined

/** Host-owned chat settings this page shows; a host that predates one omits it. */
export function read(
  settings: Partial<GlobalSettings>
): Pick<GlobalSettings, 'nativeChatPermissionMode' | 'nativeChatClaudeRemoteControl'> {
  return {
    ...runtimeChatPermissionSetting(settings),
    ...(settings.nativeChatClaudeRemoteControl === undefined
      ? {}
      : {
          nativeChatClaudeRemoteControl: nativeChatClaudeRemoteControl(
            settings.nativeChatClaudeRemoteControl
          )
        })
  }
}

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
  const result: Partial<GlobalSettings> = runtimeChatPermissionSetting(settings, false)
  // Older hosts' strict settings schema refuses keys they predate.
  const remoteControl = settings.nativeChatClaudeRemoteControl
  const autoContinue = settings.nativeChatAutoContinueAfterUsageLimit
  if (remoteControl === undefined && typeof autoContinue !== 'boolean') {
    return result
  }
  const capabilities = (await call<RuntimeStatus>(environment, 'status.get')).capabilities
  if (
    remoteControl !== undefined &&
    capabilities?.includes(AGENT_SESSION_PROVIDER_REMOTE_CONTROL_RUNTIME_CAPABILITY)
  ) {
    result.nativeChatClaudeRemoteControl = nativeChatClaudeRemoteControl(remoteControl)
  }
  if (
    typeof autoContinue === 'boolean' &&
    capabilities?.includes(AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY)
  ) {
    result.nativeChatAutoContinueAfterUsageLimit = autoContinue
  }
  return result
}
