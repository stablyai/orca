import type { Bot } from '../../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { KnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'

export function automationOwnerBot(hostId: ExecutionHostId, overrides: Partial<Bot> = {}): Bot {
  const bot: Bot = {
    id: 'b',
    name: 'Owner Bot',
    hostId: 'local',
    folder: 'bot',
    folderWorkspaceId: 'same',
    agent: 'codex',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: 'chat',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
  return Object.assign(bot, { hostId })
}

export function automationOwnerEnvironment(
  id: string,
  pairingRevision: number
): KnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision,
    runtimeId: 'origin',
    lastUsedAt: null,
    preferredEndpointId: 'fixture',
    endpoints: [
      {
        id: 'fixture',
        kind: 'websocket',
        label: 'Fixture',
        endpoint: 'ws://127.0.0.1:1',
        deviceToken: 'synthetic',
        publicKeyB64: 'synthetic'
      }
    ]
  }
}
