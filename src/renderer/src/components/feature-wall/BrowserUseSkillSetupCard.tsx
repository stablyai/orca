import type { JSX } from 'react'
import { ORCA_CLI_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import type { InstalledAgentSkillState } from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function BrowserUseSkillSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
  skill: InstalledAgentSkillState
}): JSX.Element {
  const { compact, terminalHeightPx, skill } = props

  const handleBeforeOpenTerminal = async (): Promise<void> => {
    useAppStore.getState().recordFeatureInteraction('agent-browser-setup')
    await ensureOrcaCliAvailableForAgentSkillTerminal()
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title={translate("auto.components.feature.wall.BrowserUseSkillSetupCard.d5bb1cd4ba", "Browser Use skill")}
      description={translate("auto.components.feature.wall.BrowserUseSkillSetupCard.cbc45022d4", "Enables agents to navigate and verify pages in Orca's browser.")}
      command={ORCA_CLI_SKILL_INSTALL_COMMAND}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="feature-wall-browser-use-skill-terminal"
      installed={skill.installed}
      loading={skill.loading}
      error={skill.error}
      terminalHeightPx={terminalHeightPx}
      preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
      onBeforeOpenTerminal={handleBeforeOpenTerminal}
      showRecheckWhenInstalled={false}
      onRecheck={skill.refresh}
    />
  )

  if (compact) {
    return <div className="flex min-h-24 flex-1 items-center justify-center pt-3">{setupPanel}</div>
  }
  return <div className="flex">{setupPanel}</div>
}
