import { ORCA_CLI_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { AgentSkillSetupPanel } from '../../../skills/setup/AgentSkillSetupPanel'
import { StepBadge } from '../../setup-guide/SetupStepBadge'
import { useTranslate } from '@/i18n/use-translate'
import type { BundledSkillTarget } from '@/lib/skills/runtime/bundled-skill-target'
import type { LocalAgentRuntime } from '@/lib/skills/runtime/skill-runtime-command'

type Props = {
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
  target: BundledSkillTarget | null
  // COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
  terminalRuntime?: LocalAgentRuntime
  onBeforeInstall?: () => void | Promise<void>
  onRecheck: () => void | Promise<unknown>
}

function browserSkillStepBadge(complete: boolean): React.JSX.Element {
  return <StepBadge index={1} state={complete ? 'done' : 'pending'} />
}

export function BrowserUseSkillStep({
  skillDetected,
  skillLoading,
  skillError,
  disabled = false,
  target,
  terminalRuntime,
  onBeforeInstall,
  onRecheck
}: Props): React.JSX.Element {
  const t = useTranslate()
  return (
    <AgentSkillSetupPanel
      variant="inline"
      title={t('auto.components.settings.BrowserUseSkillStep.459e24eebc', 'Browser Use skill')}
      description={t(
        'auto.components.settings.BrowserUseSkillStep.0871b6998d',
        "Enables agents to navigate and verify pages in Orca's browser."
      )}
      skillNames={[ORCA_CLI_SKILL_NAME]}
      target={target}
      terminalRuntime={terminalRuntime}
      installed={skillDetected}
      loading={skillLoading}
      error={skillError}
      installDisabled={disabled}
      leading={browserSkillStepBadge}
      onBeforeInstall={onBeforeInstall}
      onRecheck={onRecheck}
    />
  )
}
