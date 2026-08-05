import { translate } from '@/i18n/i18n'

type TerminalQuickCommandBackgroundSwitchProps = {
  openInBackground: boolean
  onToggle: () => void
}

export function TerminalQuickCommandBackgroundSwitch({
  openInBackground,
  onToggle
}: TerminalQuickCommandBackgroundSwitchProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.cf0b237949',
            'Open in background'
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.6f8f01b606',
            'Run in a new terminal without switching to it.'
          )}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={openInBackground}
        aria-label={translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandBackgroundSwitch.bbcfd77bb5',
          'Toggle open in background'
        )}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
          openInBackground ? 'bg-foreground' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
            openInBackground ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
