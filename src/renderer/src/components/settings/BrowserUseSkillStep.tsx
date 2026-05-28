import type { ReactNode } from 'react'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { StepBadge } from './BrowserUseStepBadge'

type Props = {
  command: string
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
  preInstallNotice?: ReactNode
  onBeforeOpenTerminal?: () => void | Promise<void>
  onRecheck: () => void | Promise<void>
}

export function BrowserUseSkillStep({
  command,
  skillDetected,
  skillLoading,
  skillError,
  disabled = false,
  preInstallNotice,
  onBeforeOpenTerminal,
  onRecheck
}: Props): React.JSX.Element {
  return (
    <AgentSkillSetupPanel
      variant="inline"
      title="Browser Use skill"
      description="Enables agents to navigate and verify pages in Orca's browser."
      command={command}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="settings-browser-use-skill-terminal"
      installed={skillDetected}
      loading={skillLoading}
      error={skillError}
      installDisabled={disabled}
      leading={<StepBadge index={2} state={skillDetected ? 'done' : 'pending'} />}
      preInstallNotice={preInstallNotice}
      onBeforeOpenTerminal={onBeforeOpenTerminal}
      onRecheck={onRecheck}
    />
  )
}
