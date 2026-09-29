import React from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'

type MermaidDiagramToolbarButtonProps = React.ComponentProps<typeof Button> & {
  label: string
  shortcut?: string
}

/** Icon button for the mermaid viewer's floating toolbar, labelled by a tooltip. */
export function MermaidDiagramToolbarButton({
  label,
  shortcut,
  children,
  ...props
}: MermaidDiagramToolbarButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
        {shortcut && <ShortcutKeyCombo keys={[shortcut]} className="ml-1.5" />}
      </TooltipContent>
    </Tooltip>
  )
}
