// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import { useTranslate } from '@/i18n/use-translate'

export function AgentSkillSetupFailureNotice(props: {
  exitCode: number | null
}): React.JSX.Element | null {
  const t = useTranslate()
  if (props.exitCode === null) {
    return null
  }
  return (
    <p className="mt-2 text-[12px] leading-snug text-destructive">
      {t(
        'auto.components.settings.AgentSkillSetupPanel.setupCommandFailed',
        'The setup command exited with code {{value0}}. This error will clear after a successful retry.',
        { value0: props.exitCode }
      )}
    </p>
  )
}
