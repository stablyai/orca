import { useState } from 'react'
import { ArrowRightLeft, GitBranch, ListChecks, Workflow } from 'lucide-react'
import { ORCHESTRATION_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { ORCHESTRATION_SKILL_INSTALL_COMMAND } from '@/lib/orchestration-install-command'
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
import {
  buildSkillInstallCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { OrchestrationExampleDialog } from './OrchestrationExamplesDialog'
import { OrchestrationSkillPromptDialog } from './OrchestrationSkillPromptDialog'
import { translate } from '@/i18n/i18n'

const EXAMPLE_ICONS = {
  handoff: ArrowRightLeft,
  'worktree-handoff': ArrowRightLeft,
  'child-sequence': ListChecks,
  'child-parallel': GitBranch,
  'child-worktrees': Workflow
} as const

export function OrchestrationPane(): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showOrchestration = matchesSettingsSearch(searchQuery, getOrchestrationPaneSearchEntries())
  const [selectedExampleId, setSelectedExampleId] = useState<string | null>(null)
  const [skillPromptOpen, setSkillPromptOpen] = useState(false)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const orchestrationInstallCommand =
    activeSkillRuntime.agentRuntime && !activeSkillRuntime.installDisabledReason
      ? buildSkillInstallCommandForRuntime(
          ORCHESTRATION_SKILL_INSTALL_COMMAND,
          activeSkillRuntime.agentRuntime
        )
      : ORCHESTRATION_SKILL_INSTALL_COMMAND

  const {
    installed: orchestrationSkillDetected,
    loading: orchestrationSkillLoading,
    error: orchestrationSkillError,
    skills: discoveredSkills,
    refresh: refreshOrchestrationSkill
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

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
      keywords={getOrchestrationPaneSearchEntries()[0].keywords}
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
        command={orchestrationInstallCommand}
        terminalTitle="Orchestration setup"
        terminalAriaLabel="Orchestration skill install terminal"
        terminalWorktreeId="settings-orchestration-skill-terminal"
        terminalShellOverride={activeSkillRuntime.terminalShellOverride}
        installed={orchestrationSkillDetected}
        loading={orchestrationSkillLoading}
        error={activeSkillRuntime.installDisabledReason ?? orchestrationSkillError}
        installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
        icon={<Workflow className="size-5" />}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        getPrerequisiteStatus={() =>
          activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? window.api.cli.getWslInstallStatus(
                getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
              )
            : window.api.cli.getInstallStatus()
        }
        onBeforeOpenTerminal={async () => {
          useAppStore.getState().recordFeatureInteraction('agent-orchestration-setup')
          await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
            : ensureOrcaCliAvailableForAgentSkillTerminal())
        }}
        actionHint={
          activeSkillRuntime.installDisabledReason ? null : (
            <p className="text-[12px] leading-snug text-muted-foreground">
              {translate(
                'auto.components.settings.OrchestrationPane.832f1f3ee6',
                'Prefer your own terminal?'
              )}{' '}
              <button
                type="button"
                className="font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => setSkillPromptOpen(true)}
              >
                {translate(
                  'auto.components.settings.OrchestrationPane.7bc082f4de',
                  'Copy install command'
                )}
              </button>
            </p>
          )
        }
        footer={
          <OrchestrationSkillAgentCoverage
            embedded
            skills={discoveredSkills}
            loading={orchestrationSkillLoading}
          />
        }
        onRecheck={refreshOrchestrationSkill}
      />

      <OrchestrationSkillPromptDialog
        command={orchestrationInstallCommand}
        open={skillPromptOpen}
        onOpenChange={setSkillPromptOpen}
      />

      <div className="space-y-4 border-t border-border/60 pt-6">
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-foreground">
            {translate('auto.components.settings.OrchestrationPane.ae79504732', 'How to use it')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.OrchestrationPane.52e0634e2c',
              'Ask a coordinator agent to use orchestration for handoffs, worktree handovers, and sequential or parallel child agents.'
            )}
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {getOrchestrationUsageExamples().map((example) => {
            const Icon = EXAMPLE_ICONS[example.id as keyof typeof EXAMPLE_ICONS] ?? Workflow
            return (
              <button
                key={example.id}
                type="button"
                className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-left transition-colors hover:bg-muted/35 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => setSelectedExampleId(example.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-foreground">{example.title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {example.summary}
                    </p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {getOrchestrationUsageExamples().map((example) => {
        const Icon = EXAMPLE_ICONS[example.id as keyof typeof EXAMPLE_ICONS] ?? Workflow
        return (
          <OrchestrationExampleDialog
            key={`${example.id}-dialog`}
            example={example}
            icon={Icon}
            open={selectedExampleId === example.id}
            onOpenChange={(open) => setSelectedExampleId(open ? example.id : null)}
          />
        )
      })}
    </SearchableSetting>
  )
}
