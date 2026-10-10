import React from 'react'
import { PRFilesCommentPanel } from './comment-panel'

/** Keep the changed files and their general discussion reachable in the same review surface. */
export function PRFilesReviewLayout({
  children,
  ...panelProps
}: React.ComponentProps<typeof PRFilesCommentPanel> & {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="@container h-full min-h-0">
      <div className="flex h-full min-h-0 flex-col @[56rem]:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        <PRFilesCommentPanel
          key={`${panelProps.sourceContext?.hostId ?? 'local'}:${panelProps.repoId}:${panelProps.item.url}`}
          {...panelProps}
        />
      </div>
    </div>
  )
}
