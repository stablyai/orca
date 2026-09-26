import { translate } from '@/i18n/i18n'

export function InlineSetupTerminalStallNotice(props: {
  stalled: boolean
}): React.JSX.Element | null {
  if (!props.stalled) {
    return null
  }
  return (
    <p className="mt-2 text-[12px] leading-snug text-amber-600 dark:text-amber-400">
      {translate(
        'auto.components.onboarding.InlineSetupTerminalStallNotice.body',
        'The install is still running and may be waiting for input. Answer the prompts in the terminal — they choose which agents to install into and whether to symlink or copy. You can also copy the command and run it in your own terminal.'
      )}
    </p>
  )
}
