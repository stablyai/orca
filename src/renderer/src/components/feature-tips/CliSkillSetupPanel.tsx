import { CliSkillSetupTerminal } from './CliSkillSetupTerminal'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { ORCA_CLI_SKILL_NAME, ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  hasInstalledAgentSkill,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'

const CLI_TIP_SKILL_NAMES = [ORCA_CLI_SKILL_NAME, ORCHESTRATION_SKILL_NAME] as const

function BundledCliSkillSetupPanel(): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  // Why: a repair-required runtime has no distro to scan; Install stays disabled for it.
  const agentRuntime = activeSkillRuntime.installDisabledReason
    ? undefined
    : activeSkillRuntime.agentRuntime
  const skill = useInstalledAgentSkillNames(CLI_TIP_SKILL_NAMES, {
    discoveryTarget: agentRuntime ? activeSkillRuntime.discoveryTarget : undefined,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const installed = CLI_TIP_SKILL_NAMES.every((name) =>
    hasInstalledAgentSkill(skill.skills, name, { sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS })
  )

  return (
    <AgentSkillSetupPanel
      variant="inline"
      hideHeader
      className="min-w-0"
      title={translate('auto.components.feature.tips.CliSkillSetupPanel.title', 'Skill setup')}
      description={translate(
        'auto.components.feature.tips.CliSkillSetupPanel.description',
        'Install the Orca CLI and orchestration skills for your agents.'
      )}
      skillNames={CLI_TIP_SKILL_NAMES}
      installed={installed}
      loading={skill.loading}
      error={skill.error}
      showRecheckWhenInstalled={false}
      onRecheck={skill.refresh}
    />
  )
}

export function CliSkillSetupPanel(): React.JSX.Element {
  const runtime = useActiveProjectSkillRuntime()
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  return runtime.agentRuntime?.runtime === 'wsl' ? (
    <CliSkillSetupTerminal />
  ) : (
    <BundledCliSkillSetupPanel />
  )
}
