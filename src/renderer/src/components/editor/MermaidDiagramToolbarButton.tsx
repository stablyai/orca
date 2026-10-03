import React, { createContext, useContext } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'

/** Closes the whole viewer; provided by the lightbox so toolbar tooltips can hand Escape to it. */
export const MermaidDiagramViewerCloseContext = createContext<(() => void) | null>(null)

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
  const closeViewer = useContext(MermaidDiagramViewerCloseContext)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={4}
        // Why: a focused button's tooltip is the topmost dismissable layer, so it would
        // swallow the first Escape; close the viewer instead of only the tooltip.
        onEscapeKeyDown={() => closeViewer?.()}
      >
        {label}
        {shortcut && <ShortcutKeyCombo keys={[shortcut]} className="ml-1.5" />}
      </TooltipContent>
    </Tooltip>
  )
}
