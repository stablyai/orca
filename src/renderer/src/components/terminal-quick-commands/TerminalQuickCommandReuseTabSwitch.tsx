import { translate } from '@/i18n/i18n'

type TerminalQuickCommandReuseTabSwitchProps = {
  reuseTab: boolean
  onToggle: () => void
}

export function TerminalQuickCommandReuseTabSwitch({
  reuseTab,
  onToggle
}: TerminalQuickCommandReuseTabSwitchProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">
          {translate('components.terminal.quickCommands.reuseTab.title', 'Reuse terminal tab')}
        </div>
        <div className="text-xs text-muted-foreground">
          {translate(
            'components.terminal.quickCommands.reuseTab.description',
            'Re-run in the terminal this command already opened instead of a new tab. Opens a new tab while the previous one is still busy.'
          )}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={reuseTab}
        aria-label={translate(
          'components.terminal.quickCommands.reuseTab.toggleLabel',
          'Toggle reuse terminal tab'
        )}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
          reuseTab ? 'bg-foreground' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
            reuseTab ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
