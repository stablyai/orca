import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { isAgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY,
  MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY
} from '../../../shared/managed-runtime-install'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { useAppStore } from '@/store'
import {
  hostStructuredAgentsReadFailed,
  loadHostStructuredAgents,
  readHostStructuredAgentsForRuntime,
  subscribeHostStructuredAgents
} from './host-structured-agents'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilitiesKnown
} from './local-runtime-capabilities'
import {
  observeManagedRuntimeInstall,
  readManagedRuntimeInstall,
  subscribeManagedRuntimeInstalls,
  wakeManagedRuntimeInstall,
  type ManagedRuntimeInstallSnapshot,
  type ManagedRuntimeInstallSubject
} from './managed-runtime-install-status'
import { useHostStructuredAgent } from './use-host-structured-agent'

export type ManagedRuntimeInstallObservation =
  /** Orca provides no runtime for this agent on this host, or the host cannot install one. */
  | { kind: 'inactive' }
  /** A reachable host has not yet answered its capabilities or agent list. */
  | { kind: 'pending' }
  | {
      kind: 'active'
      subject: ManagedRuntimeInstallSubject
      snapshot: ManagedRuntimeInstallSnapshot
      /** The host can also remove the runtime it installed. */
      removable: boolean
    }

const INACTIVE: ManagedRuntimeInstallObservation = { kind: 'inactive' }
const PENDING: ManagedRuntimeInstallObservation = { kind: 'pending' }
const READ_FAILED: ManagedRuntimeInstallSnapshot = { kind: 'readFailed' }

/** Null while the local runtime has not reported its capabilities. */
const localInstallCapable = (): boolean | null =>
  readLocalRuntimeCapabilitiesOrUnknown()?.includes(MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY) ??
  null
const localRemoveCapable = (): boolean =>
  readLocalRuntimeCapabilities().includes(MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY)

/** The install state of the runtime Orca provides for `agent` on the target's host. Subscribes
 *  only while `shown`, so a hidden chat holds no subscription. */
export function useManagedRuntimeInstall(
  target: RuntimeClientTarget,
  agent: string,
  shown: boolean
): ManagedRuntimeInstallObservation {
  const record = useHostStructuredAgent(target, agent)
  const managed = record?.managedRuntime === true
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const remote = useAppStore((state) =>
    environmentId === null
      ? null
      : lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(environmentId))
  )
  // The entry's own status clears on a lost contact; the verified one above outlives it.
  const reachable = useAppStore(
    (state) =>
      environmentId === null ||
      Boolean(state.runtimeStatusByEnvironmentId.get(environmentId)?.status)
  )
  const contactEpoch = useAppStore((state) =>
    environmentId === null
      ? 0
      : (state.runtimeStatusByEnvironmentId.get(environmentId)?.hostContactEpoch ?? 0)
  )
  const localCapable = useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    localInstallCapable,
    localInstallCapable
  )
  const localRemovable = useSyncExternalStore(
    subscribeLocalRuntimeCapabilitiesKnown,
    localRemoveCapable,
    localRemoveCapable
  )
  const removable =
    environmentId === null
      ? localRemovable
      : remote?.capabilities?.includes(MANAGED_RUNTIME_REMOVE_RUNTIME_CAPABILITY) === true
  const capable =
    environmentId === null
      ? localCapable
      : remote && remote.capabilities?.includes(MANAGED_RUNTIME_INSTALL_RUNTIME_CAPABILITY) === true
  const runtimeId = remote?.runtimeId ?? null
  const executionHostId =
    environmentId === null ? LOCAL_EXECUTION_HOST_ID : toRuntimeExecutionHostId(environmentId)
  const readList = useCallback(
    (): 'loaded' | 'failed' | null =>
      readHostStructuredAgentsForRuntime(executionHostId, runtimeId)
        ? 'loaded'
        : hostStructuredAgentsReadFailed(executionHostId, runtimeId)
          ? 'failed'
          : null,
    [executionHostId, runtimeId]
  )
  const list = useSyncExternalStore(subscribeHostStructuredAgents, readList, readList)
  const subject = useMemo((): ManagedRuntimeInstallSubject | null => {
    if (!capable || (environmentId !== null && runtimeId === null)) {
      return null
    }
    const host: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    return { target: host, runtimeId, agent }
  }, [agent, capable, environmentId, runtimeId])
  useEffect(
    () => (subject && managed && shown ? observeManagedRuntimeInstall(subject) : undefined),
    [subject, managed, shown]
  )
  // The host answering again after an outage resubscribes at once, not after its backoff.
  useEffect(() => {
    if (subject) {
      wakeManagedRuntimeInstall(subject)
    }
  }, [subject, contactEpoch])
  const read = useCallback(() => (subject ? readManagedRuntimeInstall(subject) : null), [subject])
  const snapshot = useSyncExternalStore(subscribeManagedRuntimeInstalls, read, read)
  const observation = useMemo((): ManagedRuntimeInstallObservation => {
    if (capable === false || (list === 'loaded' && !managed)) {
      return INACTIVE
    }
    if (subject && managed && snapshot) {
      return { kind: 'active', subject, snapshot, removable }
    }
    // A failed list leaves the chat's composer and the host's refusal, and Settings says so.
    if (subject && list === 'failed') {
      return { kind: 'active', subject, snapshot: READ_FAILED, removable }
    }
    // Only an answer a reachable host still owes may hold the slot; an unreachable one leaves the
    // composer and the host's refusal. Claude and Codex run the program every build ships.
    return reachable && !isAgentSessionHandleProvider(agent) ? PENDING : INACTIVE
  }, [agent, capable, list, managed, reachable, removable, snapshot, subject])
  const pending = observation.kind === 'pending'
  const hostCapabilities = remote?.capabilities
  // The slot waits on the host's answer, so make sure it was asked.
  useEffect(() => {
    if (pending && list === null) {
      void (
        environmentId === null
          ? ensureLocalRuntimeCapabilities()
          : Promise.resolve(hostCapabilities)
      ).then((capabilities) => loadHostStructuredAgents(executionHostId, capabilities, runtimeId))
    }
  }, [environmentId, executionHostId, hostCapabilities, list, pending, runtimeId])
  return observation
}
