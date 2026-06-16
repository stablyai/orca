import type { ReactNode } from 'react'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { StepBadge } from './BrowserUseStepBadge'
import { translate } from '@/i18n/i18n'

type Props = {
  command: string
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
  terminalShellOverride?: string
  preInstallNotice?: ReactNode
  getPrerequisiteStatus?: () => Promise<Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>>
  onBeforeOpenTerminal?: () => void | Promise<void>
  onRecheck: () => void | Promise<unknown>
}

export function BrowserUseSkillStep({
  command,
  skillDetected,
  skillLoading,
  skillError,
  disabled = false,
  terminalShellOverride,
  preInstallNotice,
  getPrerequisiteStatus,
  onBeforeOpenTerminal,
  onRecheck
}: Props): React.JSX.Element {
  return (
    <AgentSkillSetupPanel
      variant="inline"
      title={translate(
        'auto.components.settings.BrowserUseSkillStep.459e24eebc',
        'Browser Use skill'
      )}
      description={translate(
        'auto.components.settings.BrowserUseSkillStep.0871b6998d',
        "Enables agents to navigate and verify pages in Orca's browser."
      )}
      command={command}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="settings-browser-use-skill-terminal"
      terminalShellOverride={terminalShellOverride}
      installed={skillDetected}
      loading={skillLoading}
      error={skillError}
      installDisabled={disabled}
      leading={<StepBadge index={2} state={skillDetected ? 'done' : 'pending'} />}
      preInstallNotice={preInstallNotice}
      getPrerequisiteStatus={getPrerequisiteStatus}
      onBeforeOpenTerminal={onBeforeOpenTerminal}
      onRecheck={onRecheck}
    />
  )
}
