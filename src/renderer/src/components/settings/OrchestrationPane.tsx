import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { useCallback, useState } from 'react'
import { OrchestrationSkillPromptDialog } from './OrchestrationSkillPromptDialog'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/agent-feature-install-commands'
import { ArrowRightLeft, GitBranch, ListChecks, Workflow, type LucideIcon } from 'lucide-react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import { getOrchestrationUsageExamples } from '@/lib/orchestration-usage-examples'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { getOrchestrationPaneSearchEntries } from './orchestration-search'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { SkillUsageExamplesSection } from './SkillUsageExamplesSection'
import { translate } from '@/i18n/i18n'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveNestedWorkerMaxDepth } from '../../../../shared/nested-worker-depth'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { NumberField } from './SettingsFormControls'
import {
  getNestedWorkerDepthDescription,
  getNestedWorkerDepthTitle
} from './nested-worker-depth-copy'
import { OrchestrationChatErrorSetting } from './OrchestrationChatErrorSetting'

const EXAMPLE_ICONS = {
  handoff: ArrowRightLeft,
  'worktree-handoff': ArrowRightLeft,
  'child-sequence': ListChecks,
  'child-parallel': GitBranch,
  'child-worktrees': Workflow
} as const

function resolveOrchestrationExampleIcon(example: SkillUsageExample): LucideIcon {
  return EXAMPLE_ICONS[example.id as keyof typeof EXAMPLE_ICONS] ?? Workflow
}

type OrchestrationPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationPane({
  settings,
  updateSettings
}: OrchestrationPaneProps): React.JSX.Element {
  const [skillPromptOpen, setSkillPromptOpen] = useState(false)
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showLocalRuntimeSettings = !isPairedWebClientWindow()
  const searchEntries = getOrchestrationPaneSearchEntries({
    includeLocalRuntimeSettings: showLocalRuntimeSettings
  })
  const showOrchestration = matchesSettingsSearch(searchQuery, searchEntries)
  const activeSkillRuntime = useActiveProjectSkillRuntime()

  const {
    installed: orchestrationSkillDetected,
    loading: orchestrationSkillLoading,
    error: orchestrationSkillError,
    skills: discoveredSkills,
    sources: discoveredSkillSources,
    refresh: refreshOrchestrationSkill
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const renderCoverage = useCallback(
    (plan: BundledSkillPlan | undefined) =>
      plan || activeSkillRuntime.agentRuntime?.runtime === 'wsl' ? (
        <OrchestrationSkillAgentCoverage
          embedded
          plan={plan}
          skills={discoveredSkills}
          sources={discoveredSkillSources}
          loading={orchestrationSkillLoading}
        />
      ) : null,
    [
      activeSkillRuntime.agentRuntime,
      discoveredSkills,
      discoveredSkillSources,
      orchestrationSkillLoading
    ]
  )

  if (!showOrchestration) {
    return <div />
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.OrchestrationPane.191ac34567',
        'Agent Orchestration'
      )}
      description={translate(
        'auto.components.settings.OrchestrationPane.2aacdb0517',
        'Coordinate coding agents across handoffs, worktree handovers, and child-agent work.'
      )}
      keywords={searchEntries[0].keywords}
      forceVisible
      className="space-y-5 py-2"
    >
      <AgentSkillSetupPanel
        title={translate(
          'auto.components.settings.OrchestrationPane.07641b9768',
          'Orchestration skill'
        )}
        description={translate(
          'auto.components.settings.OrchestrationPane.9bedd2a6e5',
          'Enables agents to hand off context and coordinate work through Orca.'
        )}
        skillNames={[ORCHESTRATION_SKILL_NAME]}
        installed={orchestrationSkillDetected}
        loading={orchestrationSkillLoading}
        error={activeSkillRuntime.installDisabledReason ?? orchestrationSkillError}
        installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
        icon={<Workflow className="size-5" />}
        onBeforeInstall={() => {
          useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
        }}
        // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
        actionHint={
          activeSkillRuntime.agentRuntime?.runtime === 'wsl' && !orchestrationSkillDetected ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setSkillPromptOpen(true)}
            >
              {translate(
                'auto.components.settings.OrchestrationPane.7bc082f4de',
                'Copy install command'
              )}
            </button>
          ) : undefined
        }
        footer={renderCoverage}
        onRecheck={refreshOrchestrationSkill}
        freshnessSkillName={
          activeSkillRuntime.canUseSkillFreshness ? ORCHESTRATION_SKILL_NAME : undefined
        }
      />

      {showLocalRuntimeSettings ? (
        <NumberField
          label={getNestedWorkerDepthTitle()}
          description={getNestedWorkerDepthDescription()}
          value={resolveNestedWorkerMaxDepth(settings)}
          min={1}
          integer
          onChange={(nestedWorkerMaxDepth) => {
            void updateSettings({ nestedWorkerMaxDepth })
          }}
        />
      ) : null}
      {showLocalRuntimeSettings ? (
        <OrchestrationChatErrorSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {/* COMPAT(wsl-bridge): removed when WSL runs as an orcad host. */}
      {activeSkillRuntime.agentRuntime?.runtime === 'wsl' ? (
        <OrchestrationSkillPromptDialog
          command={ORCHESTRATION_SKILL_INSTALL_COMMAND}
          open={skillPromptOpen}
          onOpenChange={setSkillPromptOpen}
        />
      ) : null}
      <SkillUsageExamplesSection
        heading={translate(
          'auto.components.settings.OrchestrationPane.ae79504732',
          'How to use it'
        )}
        description={translate(
          'auto.components.settings.OrchestrationPane.52e0634e2c',
          'Ask a coordinator agent to use orchestration for handoffs, worktree handovers, and sequential or parallel child agents.'
        )}
        examples={getOrchestrationUsageExamples()}
        resolveIcon={resolveOrchestrationExampleIcon}
        slashCommand={`/${ORCHESTRATION_SKILL_NAME}`}
      />
    </SearchableSetting>
  )
}
