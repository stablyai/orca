import type { BundledSkillPlan } from '../../../../../shared/bundled-skill-plan'
import { useCallback, useState } from 'react'
import { OrchestrationSkillPromptDialog } from './OrchestrationSkillPromptDialog'
import { buildSkillCommandForRuntime } from '../../../lib/skills/runtime/skill-runtime-command'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/skills/installation/agent-feature-install-commands'
import { ArrowRightLeft, GitBranch, ListChecks, Workflow, type LucideIcon } from 'lucide-react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import type { SkillUsageExample } from '@/lib/skills/examples/skill-usage-example'
import { getOrchestrationUsageExamples } from '@/components/orchestration/setup/orchestration-usage-examples'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/skills/discovery/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/skills/runtime/useActiveProjectSkillRuntime'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '../../../store/index'
import { getOrchestrationPaneSearchEntries } from './orchestration-search'
import { AgentSkillSetupPanel } from '../../skills/setup/AgentSkillSetupPanel'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { SkillUsageExamplesSection } from '../../skills/examples/SkillUsageExamplesSection'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { resolveNestedWorkerMaxDepth } from '../../../../../shared/orchestration/workers/nested-worker-depth'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { NumberField } from '../form-controls/SettingsFormControls'
import {
  getNestedWorkerDepthDescription,
  getNestedWorkerDepthTitle
} from './nested-worker-depth-copy'
import { OrchestrationWorkerAutoReleaseSetting } from './OrchestrationWorkerAutoReleaseSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'

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
  const t = useTranslate()
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
      title={t('auto.components.settings.OrchestrationPane.8a94078d05', 'Agent orchestration')}
      description={t(
        'auto.components.settings.OrchestrationPane.2aacdb0517',
        'Coordinate coding agents across handoffs, worktree handovers, and child-agent work.'
      )}
      keywords={searchEntries[0].keywords}
      forceVisible
      className="space-y-8"
    >
      <SettingsGroup>
        <div className="py-4">
          <AgentSkillSetupPanel
            variant="inline"
            title={t(
              'auto.components.settings.OrchestrationPane.07641b9768',
              'Orchestration skill'
            )}
            description={t(
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
                  {t(
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
        </div>
        {showLocalRuntimeSettings ? (
          <NumberField
            label={getNestedWorkerDepthTitle(t)}
            description={getNestedWorkerDepthDescription(t)}
            value={resolveNestedWorkerMaxDepth(settings)}
            min={1}
            integer
            onChange={(nestedWorkerMaxDepth) => {
              void updateSettings({ nestedWorkerMaxDepth })
            }}
          />
        ) : null}
        {showLocalRuntimeSettings ? (
          <OrchestrationWorkerAutoReleaseSetting
            settings={settings}
            updateSettings={updateSettings}
          />
        ) : null}
      </SettingsGroup>

      {/* COMPAT(wsl-bridge): removed when WSL runs as an orcad host. */}
      {activeSkillRuntime.agentRuntime?.runtime === 'wsl' ? (
        <OrchestrationSkillPromptDialog
          command={buildSkillCommandForRuntime(
            ORCHESTRATION_SKILL_INSTALL_COMMAND,
            activeSkillRuntime.agentRuntime
          )}
          open={skillPromptOpen}
          onOpenChange={setSkillPromptOpen}
        />
      ) : null}
      <SkillUsageExamplesSection
        heading={t('auto.components.settings.OrchestrationPane.ae79504732', 'How to use it')}
        description={t(
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
