import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { useAppStore } from '@/store/index'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import {
  type AgentLaunchSettingsOwner,
  readHostAgentLaunchDefaults,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

export type AgentLaunchPreferences = Readonly<{
  defaultTuiAgent: GlobalSettings['defaultTuiAgent'] | undefined
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] | undefined
  agentLaunchChoices?: GlobalSettings['agentLaunchChoices']
  agentDefaultArgs?: GlobalSettings['agentDefaultArgs']
  agentPermissionDefault?: GlobalSettings['agentPermissionDefault']
  agentPermissionOverrides?: GlobalSettings['agentPermissionOverrides']
}>
export type Snapshot = AgentLaunchPreferences | 'inherited'
type Resource = {
  key: string
  owner: AgentLaunchSettingsOwner
  answer: Snapshot | null
  snapshot: Snapshot | null
  controller: AbortController | null
  deadline?: ReturnType<typeof setTimeout>
  holders: Set<() => void>
}

const INHERITED: AgentLaunchPreferences = {
  defaultTuiAgent: null,
  disabledTuiAgents: [],
  agentLaunchChoices: {},
  agentDefaultArgs: {},
  agentPermissionDefault: 'own',
  agentPermissionOverrides: {}
}
const FIRST_READ_DEADLINE_MS = 3_000
const snapshotByEnvironment = new Map<string, Resource>()
export const current = (entry: Resource): boolean =>
  snapshotByEnvironment.get(entry.owner.environmentId) === entry &&
  getRuntimeEnvironmentRevision(entry.owner.environmentId) === entry.owner.pairingRevision &&
  (lastVerifiedRuntimeStatus(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(entry.owner.environmentId)
  )?.runtimeId ?? entry.owner.runtimeId) === entry.owner.runtimeId
const publish = (entry: Resource): void => entry.holders.forEach((listener) => listener())
function stop(entry: Resource): void {
  entry.controller?.abort()
  entry.controller = null
  clearTimeout(entry.deadline)
  entry.deadline = undefined
}
function forget(environmentId: string): void {
  const entry = snapshotByEnvironment.get(environmentId)
  if (!entry) {
    return
  }
  snapshotByEnvironment.delete(environmentId)
  stop(entry)
  publish(entry)
}
onRuntimeEnvironmentsRetired((ids) => ids.forEach(forget))
onRuntimeEnvironmentRevisionsChanged((ids) => ids.forEach(forget))
function settle(entry: Resource, snapshot: Snapshot): void {
  if (!current(entry)) {
    return forget(entry.owner.environmentId)
  }
  entry.snapshot = snapshot
  clearTimeout(entry.deadline)
  entry.deadline = undefined
  publish(entry)
}
function refresh(entry: Resource): void {
  entry.controller?.abort()
  const controller = new AbortController()
  entry.controller = controller
  if (entry.snapshot === null && entry.deadline === undefined) {
    entry.deadline = setTimeout(() => settle(entry, 'inherited'), FIRST_READ_DEADLINE_MS)
  }
  const live = (): boolean => entry.controller === controller
  void readHostAgentLaunchDefaults(entry.owner, controller.signal).then(
    (defaults) => {
      if (live()) {
        const settings = defaults?.settings
        entry.controller = null
        entry.answer = settings
          ? {
              defaultTuiAgent: settings.defaultTuiAgent,
              disabledTuiAgents: settings.disabledTuiAgents,
              agentLaunchChoices: settings.agentLaunchChoices,
              agentDefaultArgs: settings.agentDefaultArgs,
              agentPermissionDefault: settings.agentPermissionDefault,
              agentPermissionOverrides: settings.agentPermissionOverrides
            }
          : (entry.answer ?? 'inherited')
        settle(entry, entry.answer)
      }
    },
    () => {
      if (live()) {
        entry.controller = null
        settle(entry, entry.answer ?? 'inherited')
      }
    }
  )
}
subscribeHostAgentLaunchSettings((owner) => {
  const entry = snapshotByEnvironment.get(owner.environmentId)
  if (entry && entry.owner.pairingRevision === owner.pairingRevision && entry.holders.size) {
    refresh(entry)
  }
})

export function clearHostAgentMenuSettingsForTests(): void {
  snapshotByEnvironment.forEach((_, id) => forget(id))
}

export function resource(owner: AgentLaunchSettingsOwner): Resource {
  const key = snapshotKey(owner.environmentId, owner.pairingRevision, owner.runtimeId)
  const previous = snapshotByEnvironment.get(owner.environmentId)
  if (previous?.key === key) {
    return previous
  }
  if (previous) {
    forget(owner.environmentId)
  }
  const entry: Resource = {
    key,
    owner,
    answer: null,
    snapshot: null,
    controller: null,
    holders: new Set()
  }
  snapshotByEnvironment.set(owner.environmentId, entry)
  return entry
}
export function acquire(entry: Resource, listener: () => void, observe: boolean): () => void {
  entry.holders.add(listener)
  if (!entry.controller && (observe || entry.snapshot === null)) {
    refresh(entry)
  }
  return () => {
    entry.holders.delete(listener)
    // Same-commit re-acquisition keeps the request and its original first-read deadline.
    queueMicrotask(() => {
      if (!entry.holders.size) {
        stop(entry)
        entry.snapshot = entry.answer
      }
    })
  }
}

export function snapshotKey(
  environmentId: string | undefined,
  pairingRevision: number | undefined,
  runtimeId: string | null | undefined
): string {
  return JSON.stringify([environmentId, pairingRevision, runtimeId])
}

export function cachedSnapshot(environmentId: string | undefined, key: string): Snapshot | null {
  const cached = environmentId ? snapshotByEnvironment.get(environmentId) : undefined
  return cached?.key === key ? cached.snapshot : null
}

export function effectiveAgentLaunchPreferences(
  owner: AgentLaunchSettingsOwner | null,
  desktop: AgentLaunchPreferences,
  snapshot: Snapshot | null
): AgentLaunchPreferences {
  if (!owner) {
    return desktop
  }
  const entry = useAppStore.getState().runtimeStatusByEnvironmentId.get(owner.environmentId)
  const status = lastVerifiedRuntimeStatus(entry)
  const currentOwner =
    !isRuntimeHostContactRevoked(entry) &&
    getRuntimeEnvironmentRevision(owner.environmentId) === owner.pairingRevision &&
    (!entry?.snapshot || entry.snapshot.pairingRevision === owner.pairingRevision) &&
    (!owner.runtimeId || !status?.runtimeId || owner.runtimeId === status.runtimeId)
  return currentOwner && snapshot && snapshot !== 'inherited' ? snapshot : INHERITED
}
