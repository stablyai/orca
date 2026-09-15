import type React from 'react'
import { PilcrowLeft, PilcrowRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type EditorTextDirectionButtonProps = {
  isRtl: boolean
  onToggle: () => void
}

export function EditorTextDirectionButton({
  isRtl,
  onToggle
}: EditorTextDirectionButtonProps): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={`p-1 rounded hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 ${
              isRtl ? 'bg-accent text-foreground' : 'text-muted-foreground'
            }`}
            onClick={onToggle}
            aria-label={translate(
              'auto.components.editor.EditorPanelHeader.7bd0a493a6',
              'Text Direction'
            )}
            aria-pressed={isRtl}
          >
            {isRtl ? <PilcrowLeft size={14} /> : <PilcrowRight size={14} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {isRtl
            ? translate('auto.components.editor.EditorPanelHeader.704af1dc90', 'Left-to-Right')
            : translate('auto.components.editor.EditorPanelHeader.3cfe5dfe5e', 'Right-to-Left')}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
