import React from 'react'
import { AlertCircle } from 'lucide-react'

/**
 * What a view is NOT showing faithfully. Azure DevOps shows the work items it could
 * load rather than none, so both the board and the backlog say what is missing.
 */
const NOTICE_CLASS =
  'flex items-center gap-2 rounded-md border border-status-warning-border bg-status-warning-background px-2 py-1 text-[11px] text-status-warning-text'

export function AzureDevOpsLoadNoticeLine({
  kind,
  children
}: {
  kind: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // The notice appears after a load settles, so it has to announce itself like the app's other warnings.
    <div role="alert" data-board-notice={kind} className={NOTICE_CLASS}>
      <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

export function AzureDevOpsLoadNotices({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-board-notices className="flex shrink-0 flex-col gap-1 px-2 pt-2">
      {children}
    </div>
  )
}
