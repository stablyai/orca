import React from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'

type RichMarkdownToolbarButtonProps = {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
  shortcut?: ShortcutKeyComboDetails
}

export function RichMarkdownToolbarButton({
  active,
  label,
  onClick,
  children,
  shortcut
}: RichMarkdownToolbarButtonProps): React.JSX.Element {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn('rich-markdown-toolbar-button', active && 'is-active')}
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4} className="flex items-center gap-2">
          <span>{label}</span>
          {shortcut && shortcut.keys.length > 0 && (
            <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
