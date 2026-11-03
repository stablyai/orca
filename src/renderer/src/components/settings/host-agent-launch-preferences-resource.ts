import { AGENT_LAUNCH_CHOICES_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import { peekRuntimeEnvironmentCapability } from '@/runtime/runtime-compatibility-cache'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../../shared/runtime-host-status'
import { useAppStore } from '@/store'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'
import {
  type AgentLaunchSettingsOwner,
  readHostAgentLaunchSettings,
  hostSupportsLaunchChoices,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

export type AgentLaunchPreferences = Readonly<{
  defaultTuiAgent: GlobalSettings['defaultTuiAgent'] | undefined
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] | undefined
  agentLaunchChoices?: GlobalSettings['agentLaunchChoices']
}>
export type Snapshot = AgentLaunchPreferences | 'desktop'
type Resource = {
  key: string
  owner: AgentLaunchSettingsOwner
  answer: Snapshot | null
  snapshot: Snapshot | null
  controller: AbortController | null
  deadline?: ReturnType<typeof setTimeout>
  holders: Set<() => void>
}

const EMPTY_CHOICES: NonNullable<GlobalSettings['agentLaunchChoices']> = {}
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
    entry.deadline = setTimeout(() => settle(entry, 'desktop'), FIRST_READ_DEADLINE_MS)
  }
  const live = (): boolean => entry.controller === controller
  void Promise.all([
    readHostAgentLaunchSettings(entry.owner, controller.signal).catch((error: unknown) => {
      if (entry.answer !== null) {
        throw error
      }
      return null
    }),
    hostSupportsLaunchChoices(entry.owner).then((supported) => {
      if (live() && current(entry)) {
        publish(entry)
      }
      return supported
    })
  ]).then(
    ([settings, choicesSupported]) => {
      if (live()) {
        entry.controller = null
        entry.answer = settings
          ? {
              defaultTuiAgent: settings.defaultTuiAgent,
              disabledTuiAgents: settings.disabledTuiAgents,
              ...(choicesSupported
                ? { agentLaunchChoices: settings.agentChoices?.defaults ?? EMPTY_CHOICES }
                : {})
            }
          : choicesSupported
            ? {
                defaultTuiAgent: useAppStore.getState().settings?.defaultTuiAgent,
                disabledTuiAgents: useAppStore.getState().settings?.disabledTuiAgents,
                agentLaunchChoices: EMPTY_CHOICES
              }
            : 'desktop'
        settle(entry, entry.answer)
      }
    },
    () => {
      if (live()) {
        entry.controller = null
        settle(entry, entry.answer ?? 'desktop')
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
  const preferences = currentOwner && snapshot && snapshot !== 'desktop' ? snapshot : desktop
  if (preferences !== desktop && preferences.agentLaunchChoices !== undefined) {
    return preferences
  }
  const capable =
    currentOwner &&
    (peekRuntimeEnvironmentCapability(
      owner.environmentId,
      AGENT_LAUNCH_CHOICES_CAPABILITY,
      owner.runtimeId
    ) ??
      status?.capabilities?.includes(AGENT_LAUNCH_CHOICES_CAPABILITY))
  return {
    ...preferences,
    agentLaunchChoices: capable ? EMPTY_CHOICES : desktop.agentLaunchChoices
  }
}
