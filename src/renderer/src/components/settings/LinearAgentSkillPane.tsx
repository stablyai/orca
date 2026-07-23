import { useMemo } from 'react'
import { ArrowRightCircle, BookOpen, Link2, ListTodo, MessageSquarePlus } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  LINEAR_AGENT_SKILL_NAMES,
  ORCA_LINEAR_SKILL_INSTALL_COMMAND,
  ORCA_LINEAR_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE,
  ensureOrcaCliAvailableForAgentSkillTerminal
} from '@/lib/agent-skill-cli-prerequisite'
import { getLinearAgentSkillUpdateTarget } from '@/lib/linear-agent-skill-update-command'
import { getLinearUsageExamples } from '@/lib/linear-usage-examples'
import type { SkillUsageExample } from '@/lib/skill-usage-example'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import {
  buildSkillCommandForRuntime,
  ensureWslCliAvailableForAgentSkillTerminal,
  getWslCliDistroRequest
} from './CliSkillRuntimeSetup'
import { getLinearAgentSkillPaneSearchEntries } from './linear-agent-skill-search'
import { SearchableSetting } from './SearchableSetting'
import { SkillUsageExamplesSection } from './SkillUsageExamplesSection'
import { translate } from '@/i18n/i18n'
export { getLinearAgentSkillPaneSearchEntries } from './linear-agent-skill-search'

const LINEAR_EXAMPLE_ICONS: Record<string, LucideIcon> = {
  'read-ticket': BookOpen,
  'post-update': MessageSquarePlus,
  'move-state': ArrowRightCircle,
  'attach-pr': Link2,
  'triage-followups': ListTodo
}

function resolveLinearExampleIcon(example: SkillUsageExample): LucideIcon {
  return LINEAR_EXAMPLE_ICONS[example.id] ?? LinearIcon
}

// Why: this section is rendered as a Settings section only when the Linear
// provider is connected, so the orca-linear agent skill sits beside the
// connection that makes it useful.
export function LinearAgentSkillPane(): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  const openIntegrationSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'integrations', repoId: null })
  }

  const {
    installed: linearSkillInstalled,
    loading: linearSkillLoading,
    error: linearSkillError,
    skills: linearSkills,
    refresh: refreshLinearSkill
  } = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  const installCommand = useMemo(
    () =>
      activeSkillRuntime.installDisabledReason
        ? ORCA_LINEAR_SKILL_INSTALL_COMMAND
        : buildSkillCommandForRuntime(
            ORCA_LINEAR_SKILL_INSTALL_COMMAND,
            activeSkillRuntime.agentRuntime
          ),
    [activeSkillRuntime.agentRuntime, activeSkillRuntime.installDisabledReason]
  )
  const updateTarget = useMemo(
    () => getLinearAgentSkillUpdateTarget(linearSkills, linearSkillInstalled),
    [linearSkillInstalled, linearSkills]
  )
  const updateCommand = useMemo(() => {
    const command = updateTarget.command
    return activeSkillRuntime.installDisabledReason
      ? command
      : buildSkillCommandForRuntime(command, activeSkillRuntime.agentRuntime)
  }, [
    activeSkillRuntime.agentRuntime,
    activeSkillRuntime.installDisabledReason,
    updateTarget.command
  ])

  return (
    <SearchableSetting
      title={translate('auto.components.settings.LinearAgentSkillPane.title', 'Linear')}
      description={translate(
        'auto.components.settings.LinearAgentSkillPane.description',
        'Give agents the skill to read and update your linked Linear tickets.'
      )}
      keywords={getLinearAgentSkillPaneSearchEntries()[0].keywords}
      className="space-y-5 py-2"
    >
      <AgentSkillSetupPanel
        title={translate(
          'auto.components.settings.LinearAgentSkillPane.skillTitle',
          'Linear skill'
        )}
        description={translate(
          'auto.components.settings.LinearAgentSkillPane.skillDescription',
          'Enables agents to read linked tickets and post updates to Linear through Orca.'
        )}
        command={installCommand}
        installedCommand={updateCommand}
        terminalTitle={translate(
          'auto.components.settings.LinearAgentSkillPane.terminalTitle',
          'Linear skill setup'
        )}
        terminalAriaLabel={translate(
          'auto.components.settings.LinearAgentSkillPane.terminalAriaLabel',
          'Linear skill install terminal'
        )}
        terminalWorktreeId="settings-linear-skill-terminal"
        terminalShellOverride={activeSkillRuntime.terminalShellOverride}
        installed={linearSkillInstalled}
        loading={linearSkillLoading}
        error={activeSkillRuntime.installDisabledReason ?? linearSkillError}
        installDisabled={Boolean(activeSkillRuntime.installDisabledReason)}
        icon={<LinearIcon className="size-5" />}
        preInstallNotice={AGENT_SKILL_CLI_PREREQUISITE_NOTICE}
        getPrerequisiteStatus={() =>
          activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? window.api.cli.getWslInstallStatus(
                getWslCliDistroRequest(activeSkillRuntime.agentRuntime)
              )
            : window.api.cli.getInstallStatus()
        }
        onBeforeOpenTerminal={async () => {
          await (activeSkillRuntime.agentRuntime?.runtime === 'wsl'
            ? ensureWslCliAvailableForAgentSkillTerminal(activeSkillRuntime.agentRuntime)
            : ensureOrcaCliAvailableForAgentSkillTerminal())
        }}
        onRecheck={refreshLinearSkill}
        // Why: the local-host-only freshness scan cannot vouch for a WSL runtime,
        // so fall back to the presence-only pill there (mirrors the other skills).
        freshnessSkillName={
          activeSkillRuntime.agentRuntime?.runtime === 'wsl' ? undefined : updateTarget.skillName
        }
      />

      <SkillUsageExamplesSection
        heading={translate(
          'auto.components.settings.LinearAgentSkillPane.howToUse',
          'How to use it'
        )}
        description={translate(
          'auto.components.settings.LinearAgentSkillPane.howToUseDescription',
          'Ask an agent working a Linear-linked worktree to read context, post updates, move the ticket, or attach the PR.'
        )}
        examples={getLinearUsageExamples()}
        resolveIcon={resolveLinearExampleIcon}
        slashCommand={`/${ORCA_LINEAR_SKILL_NAME}`}
      />

      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.LinearAgentSkillPane.manageConnectionHint',
          'Review connected Linear workspaces and API keys in'
        )}{' '}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs align-baseline"
          onClick={openIntegrationSettings}
        >
          {translate(
            'auto.components.settings.LinearAgentSkillPane.manageConnectionLink',
            'Integrations settings'
          )}
        </Button>
      </p>
    </SearchableSetting>
  )
}
