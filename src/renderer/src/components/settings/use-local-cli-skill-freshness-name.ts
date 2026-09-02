import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import type { LocalAgentRuntime } from './CliSkillRuntimeSetup'

export function useLocalCliSkillFreshnessName(agentRuntime: LocalAgentRuntime): string | undefined {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  return agentRuntime.runtime === 'host' && activeSkillRuntime.canUseLocalSkillFreshness
    ? ORCA_CLI_SKILL_NAME
    : undefined
}
