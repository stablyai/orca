import { useMemo } from 'react'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import { useSkillDiscoveryHostLabel } from '../skills/use-skill-discovery-host-label'

export type AgentSkillHostScope = { hostId: ExecutionHostId; label: string }

/** Names the machine whose skill folders were read; null while that host is unresolved. */
export function useAgentSkillHostScope(
  runtime: Pick<
    ReturnType<typeof useActiveProjectSkillRuntime>,
    'agentRuntime' | 'bundledSkillTarget'
  >
): AgentSkillHostScope | null {
  const target = runtime.bundledSkillTarget?.kind === 'ssh' ? null : runtime.bundledSkillTarget
  const targetLabel = useSkillDiscoveryHostLabel(target)
  // COMPAT(wsl-bridge): this machine reads the distro's home, so name the distro.
  const wslLabel = runtime.agentRuntime?.runtime === 'wsl' ? runtime.agentRuntime.label : null
  const hostId = wslLabel ? LOCAL_EXECUTION_HOST_ID : target && getRuntimeTargetHostId(target)
  const label = wslLabel ?? targetLabel
  return useMemo(() => (hostId && label ? { hostId, label } : null), [hostId, label])
}
