import { Workflow } from 'lucide-react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from './orchestration-search'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

export function OrchestrationPane(): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showOrchestration = matchesSettingsSearch(searchQuery, ORCHESTRATION_PANE_SEARCH_ENTRIES)

  const {
    installed: orchestrationSkillDetected,
    loading: orchestrationSkillLoading,
    error: orchestrationSkillError,
    refresh: refreshOrchestrationSkill
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  if (!showOrchestration) {
    return <div />
  }

  return (
    <SearchableSetting
      title="Agent Orchestration"
      description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
      keywords={ORCHESTRATION_PANE_SEARCH_ENTRIES[0].keywords}
      className="space-y-3 py-2"
    >
      <AgentSkillSetupPanel
        variant="inline"
        title="Orchestration skill"
        description="Enables agents to hand off context and coordinate work through Orca."
        command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
        terminalTitle="Orchestration setup"
        terminalAriaLabel="Orchestration skill install terminal"
        terminalWorktreeId="settings-orchestration-skill-terminal"
        installed={orchestrationSkillDetected}
        loading={orchestrationSkillLoading}
        error={orchestrationSkillError}
        icon={<Workflow className="size-5" />}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        onBeforeOpenTerminal={async () => {
          useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
          await ensureOrcaCliAvailableForAgentSkillTerminal()
        }}
        showInstallWhenInstalled={false}
        onRecheck={refreshOrchestrationSkill}
      />
    </SearchableSetting>
  )
}
