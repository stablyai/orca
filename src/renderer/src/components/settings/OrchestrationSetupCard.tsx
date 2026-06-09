import type { JSX } from 'react'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { useAppStore } from '@/store'

export function OrchestrationSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
  skill: InstalledAgentSkillState
}): JSX.Element {
  const { compact, terminalHeightPx, skill } = props

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title="Orchestration skill"
      description="Enables agents to hand off context and coordinate work through Orca."
      command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
      terminalTitle="Orchestration setup"
      terminalAriaLabel="Orchestration skill install terminal"
      terminalWorktreeId="feature-wall-orchestration-skill-terminal"
      installed={skill.installed}
      loading={skill.loading}
      error={skill.error}
      terminalHeightPx={terminalHeightPx}
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      onBeforeOpenTerminal={async () => {
        useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
        await ensureOrcaCliAvailableForAgentSkillTerminal()
      }}
      onRecheck={skill.refresh}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
