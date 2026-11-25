import { ORCA_CLI_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import type { LocalAgentRuntime } from '../../../lib/skills/runtime/skill-runtime-command'

export function useLocalCliSkillFreshnessName(agentRuntime: LocalAgentRuntime): string | undefined {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // CLI installation belongs to this machine, never a paired host.
  return agentRuntime.runtime === 'host' && activeSkillRuntime.bundledSkillTarget?.kind === 'local'
    ? ORCA_CLI_SKILL_NAME
    : undefined
}
