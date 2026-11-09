import React from 'react'
import type { LucideIcon } from 'lucide-react'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { CloudStateDot } from './CloudStateDot'

/**
 * The one header for full-pane Orca Cloud views (asleep, archived): a small state icon, the workspace name
 * as the title, a state line led by the state dot, and one primary action.
 */
export function CloudWorkspaceHeader({
  icon: Icon,
  title,
  state,
  stateLine,
  note,
  action,
  headingRef
}: {
  icon: LucideIcon
  title: string
  state: CloudDotState
  stateLine: string
  /** One quieter sentence under the state line. */
  note?: string
  action?: React.ReactNode
  /** Overlays focus the heading when they cover a live pane. */
  headingRef?: React.Ref<HTMLHeadingElement>
}): React.JSX.Element {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4" data-cloud-view-header="">
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 space-y-0.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-base font-semibold text-foreground outline-none"
          >
            {title}
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CloudStateDot state={state} size="md" />
            <span className="truncate">{stateLine}</span>
          </p>
          {note ? <p className="max-w-[60ch] text-xs text-muted-foreground">{note}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  )
}
