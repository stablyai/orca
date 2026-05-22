import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { StepBadge } from './BrowserUseStepBadge'

type Props = {
  command: string
  skillDetected: boolean
  skillLoading: boolean
  skillError: string | null
  disabled?: boolean
  onRecheck: () => void | Promise<void>
}

export function BrowserUseSkillStep({
  command,
  skillDetected,
  skillLoading,
  skillError,
  disabled = false,
  onRecheck
}: Props): React.JSX.Element {
  return (
    <AgentSkillSetupPanel
      variant="inline"
      title="Browser Use skill"
      detectedDescription="Detected on this machine. Agents can drive Orca's browser."
      missingDescription="Agents need this skill before they can drive Orca's browser. If you already installed it, click Re-check instead of running the installer again."
      command={command}
      terminalTitle="Browser Use setup"
      terminalAriaLabel="Browser Use skill install terminal"
      terminalWorktreeId="settings-browser-use-skill-terminal"
      installed={skillDetected}
      detected={skillDetected}
      loading={skillLoading}
      error={skillError}
      installDisabled={disabled}
      leading={<StepBadge index={2} state={skillDetected ? 'done' : 'pending'} />}
      onRecheck={onRecheck}
    />
  )
}
