import { useEffect, useState } from 'react'
import { Workflow } from 'lucide-react'
import { Label } from '../ui/label'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  ORCHESTRATION_ENABLED_STORAGE_KEY,
  ORCHESTRATION_SETUP_STATE_EVENT,
  isOrchestrationSetupEnabled,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { ORCHESTRATION_PANE_SEARCH_ENTRIES } from './orchestration-search'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

export function OrchestrationPane(): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showOrchestration = matchesSettingsSearch(searchQuery, ORCHESTRATION_PANE_SEARCH_ENTRIES)

  const [orchestrationEnabled, setOrchestrationEnabled] = useState<boolean>(() => {
    return isOrchestrationSetupEnabled()
  })

  const {
    installed: orchestrationSkillDetected,
    loading: orchestrationSkillLoading,
    error: orchestrationSkillError,
    refresh: refreshOrchestrationSkill
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: orchestrationEnabled,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  useEffect(() => {
    const syncSetupState = (): void => {
      setOrchestrationEnabled(isOrchestrationSetupEnabled())
    }
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, syncSetupState)
    return () => {
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, syncSetupState)
    }
  }, [])

  const toggleOrchestration = (value: boolean): void => {
    setOrchestrationEnabled(value)
    localStorage.setItem(ORCHESTRATION_ENABLED_STORAGE_KEY, value ? '1' : '0')
    notifyOrchestrationSetupStateChanged()
  }

  const handleRecheckOrchestrationSkill = async (): Promise<void> => {
    await refreshOrchestrationSkill()
  }

  if (!showOrchestration) {
    return <div />
  }

  return (
    <SearchableSetting
      title="Agent Orchestration"
      description="Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates."
      keywords={ORCHESTRATION_PANE_SEARCH_ENTRIES[0].keywords}
      className="space-y-3 px-1 py-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>Agent Orchestration</Label>
          <p className="text-xs text-muted-foreground">
            Coordinate multiple coding agents with messaging, task DAGs, dispatch with preamble
            injection, decision gates, and coordinator loops.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={orchestrationEnabled}
          onClick={() => toggleOrchestration(!orchestrationEnabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            orchestrationEnabled ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
              orchestrationEnabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {orchestrationEnabled ? (
        <AgentSkillSetupPanel
          title="Orchestration skill"
          detectedDescription="Detected on this machine. Agents can use inter-agent orchestration."
          missingDescription="Agents need this skill before they can use inter-agent orchestration. If you already installed it, click Re-check instead of running the installer again."
          command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
          terminalTitle="Orchestration setup"
          terminalAriaLabel="Orchestration skill install terminal"
          terminalWorktreeId="settings-orchestration-skill-terminal"
          installed={orchestrationSkillDetected}
          detected={orchestrationSkillDetected}
          loading={orchestrationSkillLoading}
          error={orchestrationSkillError}
          icon={<Workflow className="size-5" />}
          onRecheck={handleRecheckOrchestrationSkill}
        />
      ) : null}
    </SearchableSetting>
  )
}
