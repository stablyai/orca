import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import { useAppStore, type AppState } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentsRetired,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'
import {
  type AgentLaunchSettingsOwner,
  readHostAgentLaunchSettings,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

export type AgentLaunchPreferences = Readonly<{
  defaultTuiAgent: GlobalSettings['defaultTuiAgent'] | undefined
  disabledTuiAgents: GlobalSettings['disabledTuiAgents'] | undefined
}>
type Snapshot = AgentLaunchPreferences | 'desktop'
type Resource = {
  key: string
  owner: AgentLaunchSettingsOwner
  answer: Snapshot | null
  snapshot: Snapshot | null
  controller: AbortController | null
  deadline?: ReturnType<typeof setTimeout>
  holders: Set<() => void>
}

const FIRST_READ_DEADLINE_MS = 3_000
const snapshotByEnvironment = new Map<string, Resource>()
const cancelled = (): DOMException => new DOMException('Agent preferences cancelled', 'AbortError')
const current = (entry: Resource): boolean =>
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
  void readHostAgentLaunchSettings(entry.owner, controller.signal).then(
    (settings) => {
      if (live()) {
        entry.controller = null
        entry.answer = settings
          ? {
              defaultTuiAgent: settings.defaultTuiAgent,
              disabledTuiAgents: settings.disabledTuiAgents
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

function resource(owner: AgentLaunchSettingsOwner): Resource {
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
function acquire(entry: Resource, listener: () => void, observe: boolean): () => void {
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

function snapshotKey(
  environmentId: string | undefined,
  pairingRevision: number | undefined,
  runtimeId: string | null | undefined
): string {
  return JSON.stringify([environmentId, pairingRevision, runtimeId])
}

function cachedSnapshot(environmentId: string | undefined, key: string): Snapshot | null {
  const cached = environmentId ? snapshotByEnvironment.get(environmentId) : undefined
  return cached?.key === key ? cached.snapshot : null
}

function preferencesForWorkspace(state: AppState, workspace: ProspectiveWorkspace) {
  const desktop: AgentLaunchPreferences = {
    defaultTuiAgent: state.settings?.defaultTuiAgent,
    disabledTuiAgents: state.settings?.disabledTuiAgents
  }
  const host = parseExecutionHostId(
    buildAgentLaunchRouteInput(state, { agent: 'claude', workspace }).executionHostId
  )
  const owner =
    host?.kind === 'runtime'
      ? {
          environmentId: host.environmentId,
          pairingRevision: getRuntimeEnvironmentRevision(host.environmentId),
          runtimeId: lastVerifiedRuntimeStatus(
            state.runtimeStatusByEnvironmentId.get(host.environmentId)
          )?.runtimeId
        }
      : null
  return { desktop, owner }
}

/** The last menu answer; cold shortcuts preserve their synchronous desktop fallback. */
export function readAgentLaunchPreferencesForWorktree(
  state: AppState,
  worktreeId: string
): AgentLaunchPreferences {
  const { desktop, owner } = preferencesForWorkspace(state, {
    kind: workspaceKindForWorktreeId(worktreeId),
    worktreeId
  })
  const snapshot = owner
    ? cachedSnapshot(
        owner.environmentId,
        snapshotKey(owner.environmentId, owner.pairingRevision, owner.runtimeId)
      )
    : null
  return snapshot && snapshot !== 'desktop' ? snapshot : desktop
}

export async function ensureAgentLaunchPreferences(
  state: AppState,
  workspace: ProspectiveWorkspace,
  signal?: AbortSignal
): Promise<AgentLaunchPreferences> {
  if (signal?.aborted) {
    throw cancelled()
  }
  const { desktop, owner } = preferencesForWorkspace(state, workspace)
  if (!owner) {
    return desktop
  }
  const entry = resource(owner)
  const { promise, resolve, reject } = Promise.withResolvers<Snapshot>()
  const listener = (): void => {
    if (signal?.aborted || !current(entry)) {
      reject(cancelled())
    } else if (entry.snapshot !== null) {
      resolve(entry.snapshot)
    }
  }
  const release = acquire(entry, listener, false)
  signal?.addEventListener('abort', listener, { once: true })
  try {
    listener()
    const snapshot = await promise
    if (signal?.aborted || !current(entry)) {
      throw cancelled()
    }
    return snapshot === 'desktop' ? desktop : snapshot
  } finally {
    signal?.removeEventListener('abort', listener)
    release()
  }
}

export function useHostAgentMenuSettings(
  owner: {
    executionHostId: string
    pairingRevision: number | undefined
    runtimeId: string | null | undefined
    contact: string
  } | null,
  desktopSettings: GlobalSettings | null,
  active: boolean,
  open: boolean
) {
  const host = parseExecutionHostId(owner?.executionHostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : undefined
  const { pairingRevision, runtimeId, contact } = owner ?? {}
  // Contact and reopen changes renew the subscription, not the resource identity.
  const subscription = useMemo(
    () => ({ environmentId, pairingRevision, runtimeId, contact, active, open }),
    [environmentId, pairingRevision, runtimeId, contact, active, open]
  )
  const key = snapshotKey(environmentId, pairingRevision, runtimeId)
  const snapshot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        if (!subscription.environmentId || !subscription.active) {
          return () => {}
        }
        return acquire(
          resource({
            environmentId: subscription.environmentId,
            pairingRevision: subscription.pairingRevision,
            runtimeId: subscription.runtimeId ?? undefined
          }),
          listener,
          true
        )
      },
      [subscription]
    ),
    () => cachedSnapshot(environmentId, key),
    () => cachedSnapshot(environmentId, key)
  )
  if (!environmentId) {
    return { settings: desktopSettings, pending: false }
  }
  if (snapshot === null) {
    return { settings: desktopSettings, pending: true }
  }
  if (snapshot === 'desktop') {
    return { settings: desktopSettings, pending: false }
  }
  return {
    pending: false,
    settings: {
      ...desktopSettings,
      defaultTuiAgent: snapshot.defaultTuiAgent,
      disabledTuiAgents: snapshot.disabledTuiAgents
    }
  }
}
