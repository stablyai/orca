import React from 'react'
import { cn } from '@/lib/utils'

// Why: desktop hover actions should not permanently reserve project-title width;
// touch devices keep them in normal flow because there is no hover reveal.
export const PROJECT_HEADER_ACTIONS_CLASS_NAME = cn(
  'flex shrink-0 items-center gap-0.5',
  'can-hover:absolute can-hover:right-1 can-hover:top-1/2 can-hover:z-10 can-hover:-translate-y-1/2',
  'can-hover:rounded-md can-hover:bg-worktree-sidebar can-hover:pl-1',
  'can-hover:pointer-events-none can-hover:opacity-0 can-hover:transition-opacity',
  'group-hover:pointer-events-auto group-hover:opacity-100',
  'has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
  'has-[button[data-state=open]]:pointer-events-auto has-[button[data-state=open]]:opacity-100'
)

export function ProjectHeaderActions({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-repo-header-actions=""
      className={cn(PROJECT_HEADER_ACTIONS_CLASS_NAME, className)}
      {...props}
    />
  )
}
