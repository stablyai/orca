import React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/class-names'

/** A top-left navigation entry that opens a main-area page. */
export function SidebarNavPageButton({
  icon: Icon,
  label,
  active,
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'children'> & {
  icon: LucideIcon
  label: string
  active: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      {...props}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8',
        className
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
