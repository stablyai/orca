import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown,
  subscribeLocalRuntimeCapabilityObservation
} from '@/runtime/local-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus
} from '../../../shared/runtime-host-status'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import {
  inPlaceSwitchCapability,
  inPlaceSwitchExecutionCapability,
  inPlaceSwitchEnabled
} from '../../../shared/structured-agent-cli-conversation-adoption'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'

const listeners = new Set<() => void>()
const changed = () => {
  listeners.forEach((listener) => listener())
}
onRuntimeEnvironmentRevisionsChanged(changed)
onRuntimeEnvironmentsRetired(changed)
subscribeLocalRuntimeCapabilityObservation(changed)
let stopStatusSubscription: (() => void) | undefined
const subscribe = (listener: () => void) => {
  const activate = listeners.size === 0
  if (activate) {
    stopStatusSubscription = useAppStore.subscribe((state, previous) => {
      if (
        state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
        state.runtimeEnvironments !== previous.runtimeEnvironments
      ) {
        changed()
      }
    })
  }
  listeners.add(listener)
  if (activate) {
    void ensureLocalRuntimeCapabilities()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stopStatusSubscription?.()
      stopStatusSubscription = undefined
    }
  }
}

/** The addressed runtime owner's learned answer; reading never starts a probe. */
export function inPlaceSwitchCapabilityNow(
  executionHostId: string | null | undefined,
  agent: string,
  execution = false
): boolean | undefined {
  if (!inPlaceSwitchEnabled(agent)) {
    return false
  }
  const target = structuredAgentSessionTargetForHost(executionHostId)
  if (!target) {
    return undefined
  }
  if (target.kind === 'local') {
    return readLocalRuntimeCapabilitiesOrUnknown()?.includes(
      execution ? inPlaceSwitchExecutionCapability(agent) : inPlaceSwitchCapability(agent)
    )
  }
  const state = useAppStore.getState()
  if (!state.runtimeEnvironments.some((environment) => environment.id === target.environmentId)) {
    return undefined
  }
  const entry = state.runtimeStatusByEnvironmentId.get(target.environmentId)
  const status = isRuntimeHostContactRevoked(entry) ? null : lastVerifiedRuntimeStatus(entry)
  return status
    ? (status.capabilities ?? []).includes(
        execution ? inPlaceSwitchExecutionCapability(agent) : inPlaceSwitchCapability(agent)
      )
    : undefined
}

export function inPlaceSwitchSupportedNow(host: string | null | undefined, agent: string): boolean {
  return inPlaceSwitchCapabilityNow(host, agent) === true
}

/** Whether the host running this conversation switches it in place: undefined until it answers.
 *  Every surface reads it the same way: false offers the copy, undefined shows the switch disabled. */
export function useInPlaceSwitchCapability(
  executionHostId: string | null | undefined,
  agent: string | null | undefined
): boolean | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (agent ? inPlaceSwitchCapabilityNow(executionHostId, agent) : false),
    () => false
  )
}

export function useInPlaceSwitchSupported(
  host: string | null | undefined,
  agent: string | null | undefined
): boolean {
  return useInPlaceSwitchCapability(host, agent) === true
}

/** A History row's agent unless its host answered that it doesn't switch this agent in place: the
 *  row then offers the copy, and until the host answers it shows the switch disabled. */
export function useAiVaultInPlaceAgent(session: {
  agent: AiVaultAgent
  executionHostId?: string | null
}): AiVaultAgent | undefined {
  return useInPlaceSwitchCapability(session.executionHostId, session.agent) === false
    ? undefined
    : session.agent
}
