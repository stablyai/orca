import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { WorkingSpinner } from './feature-tour-preview-glyphs'

type SetupScriptWorkspaceListCardProps = {
  title: string
  active: boolean
  prompt?: string
  icon?: ReactNode
  state: 'idle' | 'starting' | 'setup' | 'working'
  reducedMotion: boolean
  className?: string
}

export function SetupScriptWorkspaceListCard(
  props: SetupScriptWorkspaceListCardProps
): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border border-sidebar-border px-2 py-1.5 transition-colors duration-300',
        props.active ? 'bg-sidebar-accent' : 'bg-sidebar',
        props.className
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full transition-colors duration-300',
            props.active ? 'bg-emerald-500' : 'bg-muted-foreground/35'
          )}
        />
        <span className="truncate text-xs font-semibold text-sidebar-foreground">
          {props.title}
        </span>
      </div>
      {props.prompt ? (
        <div className="mt-1.5 grid grid-cols-[8px_14px_minmax(0,1fr)] items-center gap-1.5">
          {props.state === 'working' || props.state === 'starting' || props.state === 'setup' ? (
            <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
          ) : (
            <span className="size-1.5 rounded-full bg-muted-foreground/35" />
          )}
          <span className="flex size-3.5 items-center justify-center text-sidebar-foreground/65">
            {props.icon}
          </span>
          <span className="truncate font-mono text-[10px] text-sidebar-foreground/65">
            {props.state === 'setup' ? 'running setup' : props.prompt}
          </span>
        </div>
      ) : null}
    </div>
  )
}
