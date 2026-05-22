import { useEffect, type JSX } from 'react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

export function OrchestrationSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
  onInstalledChange?: (installed: boolean) => void
}): JSX.Element {
  const { compact, terminalHeightPx, onInstalledChange } = props
  const {
    installed: skillInstalled,
    loading: skillLoading,
    error: skillError,
    refresh: refreshSkillInstalled
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  useEffect(() => {
    onInstalledChange?.(skillInstalled)
  }, [onInstalledChange, skillInstalled])

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title="Orchestration skill"
      detectedDescription="Detected on this machine. Agents can use inter-agent orchestration."
      missingDescription="Agents need this skill before they can use inter-agent orchestration. If you already installed it, click Re-check instead of running the installer again."
      command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
      terminalTitle="Orchestration setup"
      terminalAriaLabel="Orchestration skill install terminal"
      terminalWorktreeId="feature-wall-orchestration-skill-terminal"
      installed={skillInstalled}
      detected={skillInstalled}
      loading={skillLoading}
      error={skillError}
      terminalHeightPx={terminalHeightPx}
      showRecheckWhenInstalled={false}
      onRecheck={refreshSkillInstalled}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center pt-3">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
