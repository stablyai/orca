import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import type { LocalAgentRuntime } from './CliSkillRuntimeSetup'

export function useLocalCliSkillFreshnessName(agentRuntime: LocalAgentRuntime): string | undefined {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // Why local: this section installs the CLI on this machine, never a paired host.
  return agentRuntime.runtime === 'host' && activeSkillRuntime.bundledSkillTarget?.kind === 'local'
    ? ORCA_CLI_SKILL_NAME
    : undefined
}
