import { ArrowDown, ArrowUp, Check, Circle, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  WorkspaceSpaceSortDirection,
  WorkspaceSpaceSortKey
} from './workspace-space-presentation'

export function CheckButton({
  checked,
  disabled,
  label,
  onClick
}: {
  checked: boolean | 'mixed'
  disabled?: boolean
  label: string
  onClick: () => void
}): React.JSX.Element {
  const isChecked = checked === true
  const isMixed = checked === 'mixed'
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-default opacity-35'
      )}
    >
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-sm border transition-colors',
          isChecked || isMixed
            ? 'border-foreground bg-foreground text-background'
            : 'border-muted-foreground/50 bg-background/40 text-transparent'
        )}
      >
        {isChecked ? <Check className="size-3" strokeWidth={3} /> : null}
        {isMixed ? <Minus className="size-3" strokeWidth={3} /> : null}
      </span>
    </button>
  )
}

export function SortIndicator({
  sortKey,
  activeKey,
  direction
}: {
  sortKey: WorkspaceSpaceSortKey
  activeKey: WorkspaceSpaceSortKey
  direction: WorkspaceSpaceSortDirection
}): React.JSX.Element {
  if (sortKey !== activeKey) {
    return <Circle className="size-3 opacity-0" />
  }
  return direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
}
