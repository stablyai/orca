import { useMemo } from 'react'
import { SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY } from '../../../../shared/ssh-target-management'
import {
  useStructuredAgentSessionHostCapabilityState,
  type StructuredAgentSessionHostCapabilityState
} from '@/runtime/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type ServerSshProjects = {
  state: StructuredAgentSessionHostCapabilityState
  environmentId: string
  label: string
  onTargetsChanged: () => void
}

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

/** Whether the selected paired server can add projects on its own SSH hosts; null for no server. */
export function useServerSshProjects(
  environmentId: string | null,
  label: string | null,
  onTargetsChanged: () => void
): ServerSshProjects | null {
  const target = useMemo<RuntimeClientTarget>(
    () => (environmentId ? { kind: 'environment', environmentId } : LOCAL_TARGET),
    [environmentId]
  )
  const state = useStructuredAgentSessionHostCapabilityState(
    target,
    SSH_TARGET_MANAGEMENT_RUNTIME_CAPABILITY
  )
  return useMemo(
    () =>
      environmentId
        ? { state, environmentId, label: label ?? environmentId, onTargetsChanged }
        : null,
    [environmentId, label, onTargetsChanged, state]
  )
}
