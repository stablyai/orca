import React from 'react'
import { cn } from '@/lib/class-names'

const PROJECT_ACTIONS_CLASS_NAME = cn(
  'flex shrink-0 cursor-pointer items-center gap-0.5 self-stretch',
  'can-hover:pointer-events-none can-hover:opacity-0 can-hover:transition-opacity',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  'has-[button[aria-expanded=true]]:pointer-events-auto has-[button[aria-expanded=true]]:opacity-100'
)

export function ProjectHeaderActions({
  className,
  inline = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { inline?: boolean }): React.JSX.Element {
  return (
    <div
      data-repo-header-actions=""
      className={cn(
        PROJECT_ACTIONS_CLASS_NAME,
        inline
          ? 'group-hover/sidebar-workspace:pointer-events-auto group-hover/sidebar-workspace:opacity-100'
          : 'can-hover:absolute can-hover:right-1 can-hover:top-1/2 can-hover:z-10 can-hover:-translate-y-1/2 can-hover:rounded-md can-hover:bg-worktree-sidebar can-hover:pl-1 group-hover:pointer-events-auto group-hover:opacity-100',
        className
      )}
      {...props}
    />
  )
}
