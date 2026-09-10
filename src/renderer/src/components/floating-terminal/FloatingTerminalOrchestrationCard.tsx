import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type FloatingTerminalOrchestrationCardProps = {
  visible: boolean
  onDismiss: () => void
  onEnable: () => void
}

export function renderFloatingTerminalOrchestrationCard({
  visible,
  onDismiss,
  onEnable
}: FloatingTerminalOrchestrationCardProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }
  return (
    <div
      className="absolute right-4 bottom-4 z-10 w-[280px] rounded-md border border-border/60 bg-card/95 p-3 text-card-foreground shadow-xs"
      data-floating-terminal-no-drag
    >
      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.2a3c5ddf5e',
              'Enable orchestration'
            )}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.8cf80db43b',
              'Set up the Orca CLI and agent skill so agents can coordinate through Orca.'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={onDismiss}>
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.adc281394d',
              'Dismiss'
            )}
          </Button>
          <Button type="button" variant="default" size="sm" className="flex-1" onClick={onEnable}>
            {translate(
              'auto.components.floating.terminal.FloatingTerminalPanel.bbc177f98f',
              'Enable'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
