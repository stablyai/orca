import { type JSX } from 'react'
import { toast } from 'sonner'
import {
  ORCA_CLI_SKILL_INSTALL_COMMAND,
  ORCA_CLI_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { AgentSkillSetupPanel } from '@/components/settings/AgentSkillSetupPanel'

export function OrcaCliSkillSetupCard(props: {
  compact?: boolean
  terminalHeightPx?: number
}): JSX.Element {
  const { compact, terminalHeightPx } = props
  const {
    installed: skillInstalled,
    loading: skillLoading,
    error: skillError,
    refresh: refreshSkillInstalled
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  // Why: matches the onboarding flow (runOnboardingFeatureSetup) — registering
  // the `orca` CLI is a prerequisite for the skill, so we do it implicitly when
  // the user opts into setup. Failures surface as a toast but don't block the
  // terminal, since the user may already have it installed via another path.
  const handleBeforeOpenTerminal = async (): Promise<void> => {
    try {
      const status = await window.api.cli.getInstallStatus()
      if (status.supported && status.state !== 'installed') {
        await window.api.cli.install()
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to register the orca CLI in PATH.'
      )
    }
    localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  }

  const setupPanel = (
    <AgentSkillSetupPanel
      className={compact ? 'w-full max-w-[520px]' : undefined}
      title="CLI skill"
      detectedDescription="Detected on this machine. Agents know how to use Orca and report status."
      missingDescription="Agents need this skill before they can use Orca and report status. If you already installed it, click Re-check instead of running the installer again."
      command={ORCA_CLI_SKILL_INSTALL_COMMAND}
      terminalTitle="CLI skill setup"
      terminalAriaLabel="CLI skill install terminal"
      terminalWorktreeId="feature-wall-orca-cli-skill-terminal"
      installed={skillInstalled}
      detected={skillInstalled}
      loading={skillLoading}
      error={skillError}
      terminalHeightPx={terminalHeightPx}
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
