import { useEffect, useState } from 'react'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import type { AppState } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId
} from '@/lib/agent-launch-route-input'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  readHostAgentLaunchSettings,
  subscribeHostAgentLaunchSettings
} from './agent-launch-settings-transport'

type Preferences = Pick<AgentLaunchSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>
/** `desktop`: the host predates host launch settings or has not answered, so this client's own choices apply. */
type Snapshot = Preferences | 'desktop'
type Observation = { key: string; snapshot: Snapshot | null }

// Why: a stalled host must not hold the menu on placeholders for the full RPC timeouts.
const FIRST_READ_DEADLINE_MS = 3_000

// Why: menus mount on open; the last answer per host lets them render at once while revalidating.
const snapshotByEnvironment = new Map<string, { key: string; snapshot: Snapshot }>()
subscribeHostAgentLaunchSettings((owner) => {
  snapshotByEnvironment.delete(owner.environmentId)
})

export function clearHostAgentMenuSettingsForTests(): void {
  snapshotByEnvironment.clear()
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

/** The launch preferences the worktree's menu last applied, so shortcuts launch what the menu shows. */
export function readAgentLaunchPreferencesForWorktree(
  state: AppState,
  worktreeId: string
): { [K in keyof Preferences]: Preferences[K] | undefined } {
  const desktop = {
    defaultTuiAgent: state.settings?.defaultTuiAgent,
    disabledTuiAgents: state.settings?.disabledTuiAgents
  }
  const workspace = { kind: workspaceKindForWorktreeId(worktreeId), worktreeId }
  const host = parseExecutionHostId(
    buildAgentLaunchRouteInput(state, { agent: 'claude', workspace }).executionHostId
  )
  if (host?.kind !== 'runtime') {
    return desktop
  }
  const status = state.runtimeStatusByEnvironmentId.get(host.environmentId)
  const key = snapshotKey(
    host.environmentId,
    getRuntimeEnvironmentRevision(host.environmentId),
    lastVerifiedRuntimeStatus(status)?.runtimeId
  )
  const snapshot = cachedSnapshot(host.environmentId, key)
  return snapshot && snapshot !== 'desktop' ? snapshot : desktop
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
  const key = snapshotKey(environmentId, pairingRevision, runtimeId)
  const [observation, setObservation] = useState<Observation>(() => ({
    key,
    snapshot: cachedSnapshot(environmentId, key)
  }))
  useEffect(() => {
    if (!environmentId || !active) {
      return
    }
    const capturedOwner = { environmentId, pairingRevision, runtimeId: runtimeId ?? undefined }
    let controller = new AbortController()
    let live = true
    const deadline = setTimeout(() => {
      if (live) {
        setObservation((prev) =>
          prev.key === key && prev.snapshot
            ? prev
            : { key, snapshot: cachedSnapshot(environmentId, key) ?? 'desktop' }
        )
      }
    }, FIRST_READ_DEADLINE_MS)
    const refresh = (): void => {
      controller.abort()
      const readController = new AbortController()
      controller = readController
      void readHostAgentLaunchSettings(capturedOwner, readController.signal).then(
        (settings) => {
          if (live && !readController.signal.aborted) {
            const snapshot = settings
              ? {
                  defaultTuiAgent: settings.defaultTuiAgent,
                  disabledTuiAgents: settings.disabledTuiAgents
                }
              : 'desktop'
            snapshotByEnvironment.set(environmentId, { key, snapshot })
            setObservation({ key, snapshot })
          }
        },
        () => {
          if (live && !readController.signal.aborted) {
            // Why: a failed refresh keeps this runtime's last answer; with none, desktop choices apply as before.
            setObservation({ key, snapshot: cachedSnapshot(environmentId, key) ?? 'desktop' })
          }
        }
      )
    }
    const unsubscribe = subscribeHostAgentLaunchSettings((changedOwner) => {
      if (
        changedOwner.environmentId === environmentId &&
        changedOwner.pairingRevision === pairingRevision
      ) {
        refresh()
      }
    })
    refresh()
    return () => {
      live = false
      clearTimeout(deadline)
      controller.abort()
      unsubscribe()
    }
  }, [environmentId, pairingRevision, runtimeId, key, contact, active, open])
  if (!environmentId) {
    return { settings: desktopSettings, pending: false }
  }
  const snapshot =
    (observation.key === key ? observation.snapshot : null) ?? cachedSnapshot(environmentId, key)
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
