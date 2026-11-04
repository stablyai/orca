import React, { useRef } from 'react'
import { flushSync } from 'react-dom'
import { FileExplorerViewSwitch } from './FileExplorerViewSwitch'
import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

type FileExplorerQueryStripProps = {
  view: RightSidebarExplorerView
  onSelectView: (view: RightSidebarExplorerView) => void
  children: React.ReactNode
}

export function FileExplorerQueryStrip({
  view,
  onSelectView,
  children
}: FileExplorerQueryStripProps): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const focusedQuery = (): HTMLInputElement | null =>
    stripRef.current?.querySelector<HTMLInputElement>('[data-explorer-query-input]:focus') ?? null

  const handleSelectView = (nextView: RightSidebarExplorerView): void => {
    if (!focusedQuery()) {
      onSelectView(nextView)
      return
    }

    // Commit visibility before focusing the other mounted query field.
    flushSync(() => onSelectView(nextView))
    stripRef.current
      ?.querySelector<HTMLInputElement>(`[data-explorer-query-input="${nextView}"]`)
      ?.focus({ preventScroll: true })
  }

  return (
    <div
      ref={stripRef}
      className="border-b border-border px-2 py-2"
      onPointerDownCapture={(event) => {
        if (
          event.button === 0 &&
          event.target instanceof Element &&
          event.target.closest('[data-slot="toggle-group"]') &&
          focusedQuery()
        ) {
          event.preventDefault()
        }
      }}
    >
      <div className="flex flex-col gap-2">
        <FileExplorerViewSwitch view={view} onSelectView={handleSelectView} />
        {children}
      </div>
    </div>
  )
}
