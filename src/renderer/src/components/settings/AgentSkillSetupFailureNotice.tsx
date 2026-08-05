import { translate } from '@/i18n/i18n'

export function AgentSkillSetupFailureNotice(props: {
  exitCode: number | null
}): React.JSX.Element | null {
  if (props.exitCode === null) {
    return null
  }
  return (
    <p className="mt-2 text-[12px] leading-snug text-destructive">
      {translate(
        'auto.components.settings.AgentSkillSetupPanel.setupCommandFailed',
        'The setup command exited with code {{value0}}. This error will clear after a successful retry.',
        { value0: props.exitCode }
      )}
    </p>
  )
}
