import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FilterOptionCount } from './FilterOptionCount'

type AgentMapFilterCheckboxProps = {
  label: string
  checked: boolean
  count: number
  onToggle: () => void
  leading?: React.ReactNode
}

/** A filter row in the map's popover. Not a menu item: the panel holds sliders,
 *  and a Radix menu would swallow the arrow keys those need. */
export function AgentMapFilterCheckbox({
  label,
  checked,
  count,
  onToggle,
  leading
}: AgentMapFilterCheckboxProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs',
        'hover:bg-accent/50',
        count === 0 && !checked && 'opacity-50'
      )}
    >
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
          checked ? 'border-foreground bg-foreground text-background' : 'border-input'
        )}
      >
        {checked ? <Check className="size-2.5" strokeWidth={3.5} aria-hidden /> : null}
      </span>
      {leading}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <FilterOptionCount count={count} />
    </button>
  )
}
