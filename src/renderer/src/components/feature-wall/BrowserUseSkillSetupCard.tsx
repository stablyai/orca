import { useEffect, type JSX } from 'react'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'

export function BrowserUseSkillSetupCard(props: {
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
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  useEffect(() => {
    onInstalledChange?.(skillInstalled)
  }, [onInstalledChange, skillInstalled])

  const handleBeforeOpenTerminal = async (): Promise<void> => {
    await ensureOrcaCliAvailableForAgentSkillTerminal()
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title="Browser Use skill"
      description="Enables agents to navigate and verify pages in Orca's browser."
      command={ORCA_CLI_SKILL_INSTALL_COMMAND}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="feature-wall-browser-use-skill-terminal"
      installed={skillInstalled}
      loading={skillLoading}
      error={skillError}
      terminalHeightPx={terminalHeightPx}
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      onBeforeOpenTerminal={handleBeforeOpenTerminal}
      showRecheckWhenInstalled={false}
      onRecheck={refreshSkillInstalled}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center pt-3">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
