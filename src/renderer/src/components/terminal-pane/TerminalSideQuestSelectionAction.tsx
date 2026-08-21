import { useEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function TerminalSideQuestSelectionAction({
  point,
  onStart,
  onDismiss
}: {
  point: { x: number; y: number }
  onStart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onDismiss()
      }
    }
    window.addEventListener('keydown', dismissOnEscape)
    return () => window.removeEventListener('keydown', dismissOnEscape)
  }, [onDismiss])

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-terminal-side-quest-selection-action="true"
      className="fixed z-50 h-7 -translate-x-1/2 gap-1.5 border border-border/80 bg-popover px-2.5 text-xs font-medium text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)] hover:bg-accent hover:text-accent-foreground"
      style={{ left: point.x, top: point.y }}
      onPointerDown={(event) => {
        // Why: xterm clears its selection when focus moves, but this action must
        // launch with the exact text shown when the action appeared.
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={onStart}
    >
      <MessageSquarePlus className="size-3.5" />
      {translate(
        'auto.components.terminal.pane.TerminalContextMenu.addSelectionToSideQuest',
        'Add to Side Quest'
      )}
    </Button>
  )
}
