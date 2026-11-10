import { ORCA_CLI_SKILL_NAME } from '@/lib/skills/installation/agent-feature-skill-names'
import { AgentSkillSetupPanel } from '../../../skills/setup/AgentSkillSetupPanel'
import { StepBadge } from '../../setup-guide/SetupStepBadge'
import { useTranslate } from '@/i18n/use-translate'

type Props = {
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
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
