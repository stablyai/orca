import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import type { AppState } from '@/store'
import {
  buildAgentLaunchRouteInput,
  workspaceKindForWorktreeId,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import {
  type AgentLaunchPreferences,
  type Snapshot,
  current,
  resource,
  acquire,
  snapshotKey,
  cachedSnapshot,
  effectiveAgentLaunchPreferences
} from './host-agent-launch-preferences-resource'
export { clearHostAgentMenuSettingsForTests } from './host-agent-launch-preferences-resource'
export type { AgentLaunchPreferences } from './host-agent-launch-preferences-resource'

const cancelled = (): DOMException => new DOMException('Agent preferences cancelled', 'AbortError')

function preferencesForWorkspace(state: AppState, workspace: ProspectiveWorkspace) {
  const desktop: AgentLaunchPreferences = {
    defaultTuiAgent: state.settings?.defaultTuiAgent,
    disabledTuiAgents: state.settings?.disabledTuiAgents,
    ...(state.settings?.agentLaunchChoices !== undefined
      ? { agentLaunchChoices: state.settings.agentLaunchChoices }
      : {})
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

/** The current owner model map shares the existing availability fallback. */
export function readAgentLaunchPreferencesForWorkspace(
  state: AppState,
  workspace: ProspectiveWorkspace
): AgentLaunchPreferences {
  const { desktop, owner } = preferencesForWorkspace(state, workspace)
  const snapshot = owner
    ? cachedSnapshot(
        owner.environmentId,
        snapshotKey(owner.environmentId, owner.pairingRevision, owner.runtimeId)
      )
    : null
  return effectiveAgentLaunchPreferences(owner, desktop, snapshot)
}

export function readAgentLaunchPreferencesForWorktree(
  state: AppState,
  worktreeId: string
): AgentLaunchPreferences {
  return readAgentLaunchPreferencesForWorkspace(state, {
    kind: workspaceKindForWorktreeId(worktreeId),
    worktreeId
  })
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
    return effectiveAgentLaunchPreferences(owner, desktop, snapshot)
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
  const effectiveSnapshot = useShallow(() => {
    const snapshot = cachedSnapshot(environmentId, key)
    const preferences = effectiveAgentLaunchPreferences(
      environmentId ? { environmentId, pairingRevision, runtimeId: runtimeId ?? undefined } : null,
      {
        defaultTuiAgent: desktopSettings?.defaultTuiAgent,
        disabledTuiAgents: desktopSettings?.disabledTuiAgents,
        agentLaunchChoices: desktopSettings?.agentLaunchChoices
      },
      snapshot
    )
    return [
      preferences.defaultTuiAgent,
      preferences.disabledTuiAgents,
      preferences.agentLaunchChoices,
      snapshot === null
    ] as const
  })
  const [defaultTuiAgent, disabledTuiAgents, agentLaunchChoices, pending] = useSyncExternalStore(
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
    () => effectiveSnapshot(undefined),
    () => effectiveSnapshot(undefined)
  )
  if (!environmentId) {
    return { settings: desktopSettings, pending: false }
  }
  return {
    pending,
    settings: {
      ...desktopSettings,
      defaultTuiAgent,
      disabledTuiAgents,
      agentLaunchChoices
    }
  }
}
