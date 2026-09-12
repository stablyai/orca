import { TextCursorInput } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'

type TerminalPaneRichInputToggleProps = {
  isOpen: boolean | undefined
  onToggle: (() => void) | undefined
}

export function TerminalPaneRichInputToggle({
  isOpen,
  onToggle
}: TerminalPaneRichInputToggleProps): React.JSX.Element {
  const shortcut = useShortcutKeyDetails('terminal.richInput.toggle')
  const label = translate('components.terminal.richInput.toggle', 'Toggle rich terminal input')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="pane-title-split-trigger"
          aria-label={label}
          aria-pressed={isOpen}
          onClick={(event) => {
            event.stopPropagation()
            onToggle?.()
          }}
        >
          <TextCursorInput className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="flex items-center gap-2" side="bottom" sideOffset={4}>
        <span>{label}</span>
        {shortcut.keys.length > 0 ? (
          <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
