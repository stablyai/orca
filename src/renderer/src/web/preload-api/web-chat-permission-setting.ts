import { isAgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { HostChatPermissionSetting } from '../../runtime/host-chat-permission-setting'

const hostSetting = new HostChatPermissionSetting()

function owner(environment: StoredWebRuntimeEnvironment | null): string | null {
  return environment
    ? JSON.stringify([environment.id, environment.pairingRevision ?? environment.createdAt])
    : null
}

export function beginWebChatPermissionRead() {
  const requestedOwner = webChatPermissionOwner()
  return requestedOwner ? hostSetting.beginRead(requestedOwner) : null
}

export function captureWebChatPermissionSetting(
  read: ReturnType<typeof beginWebChatPermissionRead>,
  settings: Partial<GlobalSettings>,
  confirmedWrite = false
): void {
  if (read && read.owner === webChatPermissionOwner()) {
    if (confirmedWrite) {
      hostSetting.captureWrite(read.owner, settings)
    } else {
      hostSetting.captureRead(read, settings)
    }
  }
}

export function webChatPermissionOwner(): string | null {
  return owner(requireActiveEnvironmentOrNull())
}

/** Browser persistence cannot attest to an execution host's permission default. */
export function settingsForWebChatPermissionOwner(settings: GlobalSettings): GlobalSettings {
  const currentOwner = webChatPermissionOwner()
  return {
    ...settings,
    nativeChatPermissionMode: currentOwner ? hostSetting.value(currentOwner) : undefined
  }
}

export function webChatPermissionUpdate(updates: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const currentOwner = webChatPermissionOwner()
  return currentOwner &&
    hostSetting.value(currentOwner) !== undefined &&
    isAgentChatPermissionMode(updates.nativeChatPermissionMode)
    ? { nativeChatPermissionMode: updates.nativeChatPermissionMode }
    : {}
}
