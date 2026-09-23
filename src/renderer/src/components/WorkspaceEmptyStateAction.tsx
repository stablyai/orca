import type { ReactNode } from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'

type WorkspaceEmptyStateActionProps = {
  icon: ReactNode
  label: ReactNode
  onClick: () => void
  shortcut: ShortcutKeyComboDetails
  contextualTourTarget?: string
}

export function WorkspaceEmptyStateAction({
  icon,
  label,
  onClick,
  shortcut,
  contextualTourTarget
}: WorkspaceEmptyStateActionProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      className="grid h-8 w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-3 py-0 text-sm font-normal text-foreground hover:bg-muted/40 hover:text-foreground"
      data-contextual-tour-target={contextualTourTarget}
      onClick={onClick}
    >
      {icon}
      <span className="truncate text-left leading-none">{label}</span>
      {shortcut.keys.length > 0 ? (
        <ShortcutKeyCombo
          keys={shortcut.keys}
          doubleTap={shortcut.doubleTap}
          className="self-center justify-self-end opacity-90 [&>span]:text-foreground"
          separatorClassName="mx-0 text-[9px] text-foreground"
        />
      ) : (
        <span aria-hidden />
      )}
    </Button>
  )
}
