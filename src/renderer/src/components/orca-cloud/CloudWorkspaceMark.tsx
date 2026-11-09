import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Cloud } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { CloudStateDot } from './CloudStateDot'
import { cloudStateLabel } from './cloud-state-copy'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import { useCloudStatusPolling, useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  runArchiveCloudWorkspace,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace
} from './cloud-workspace-actions'

const PANEL_POLL_MS = 5_000
const HOVER_OPEN_MS = 250
const HOVER_CLOSE_MS = 180

/**
 * Sidebar mark for an Orca Cloud workspace: a cloud glyph with a live state dot. Hover previews,
 * click or Enter opens the status panel (CPU, memory, disk, uptime, hours and cost, Restart / Archive).
 * Renders nothing for workspaces that are not on Orca Cloud.
 */
export function CloudWorkspaceMark({
  workspaceId,
  onPointerDown
}: {
  workspaceId: string
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element | null {
  const view = useCloudWorkspaceView(workspaceId)
  if (!view.isCloud) {
    return null
  }
  return <CloudWorkspaceMarkInner workspaceId={workspaceId} view={view} onPointerDown={onPointerDown} />
}

function CloudWorkspaceMarkInner({
  workspaceId,
  view,
  onPointerDown
}: {
  workspaceId: string
  view: ReturnType<typeof useCloudWorkspaceView>
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const t = useTranslate()
  // Hover previews (focus stays put); click or Enter opens it for keyboard use (focus moves in).
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  useEffect(() => clearTimer, [clearTimer])
  const hoverIn = (): void => {
    clearTimer()
    if (open === null) {
      timer.current = setTimeout(() => setOpen('hover'), HOVER_OPEN_MS)
    }
  }
  const hoverOut = (): void => {
    clearTimer()
    if (open === 'hover') {
      timer.current = setTimeout(() => setOpen(null), HOVER_CLOSE_MS)
    }
  }
  useCloudStatusPolling(workspaceId, PANEL_POLL_MS, open !== null)
  const label = t('orcaCloudWorkspace.markLabel', 'Orca Cloud: {{state}}', {
    state: cloudStateLabel(view.state, t)
  })
  return (
    <Popover
      open={open !== null}
      onOpenChange={(next) => {
        clearTimer()
        setOpen(next ? 'pinned' : null)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="dialog"
          data-cloud-workspace-mark={view.state}
          // The row activates on click; the mark only opens its panel.
          onPointerDown={(event) => {
            event.stopPropagation()
            onPointerDown?.(event)
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (open === 'hover') {
              // Clicking a hover preview pins it instead of toggling it closed.
              event.preventDefault()
              clearTimer()
              setOpen('pinned')
            }
          }}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          className={cn(
            'relative inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground',
            'hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring'
          )}
        >
          <Cloud className="size-3" aria-hidden="true" />
          <CloudStateDot
            state={view.state}
            className="absolute right-0 bottom-0.5 ring-[1.5px] ring-worktree-sidebar"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-72 p-3 outline-none"
        aria-label={label}
        onPointerEnter={() => clearTimer()}
        onPointerLeave={hoverOut}
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Hover previews keep focus in the sidebar; a pinned panel takes focus itself (not its
          // first action, so Enter can't archive by accident).
          event.preventDefault()
          if (open !== 'hover') {
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <CloudWorkspaceStatusPanel
          workspaceId={workspaceId}
          state={view.state}
          entry={view.entry}
          pending={view.pending}
          actions={{
            onRestart: () => void runRestartCloudWorkspace(workspaceId),
            onArchive: () => void runArchiveCloudWorkspace(workspaceId),
            onUnarchive: () => void runUnarchiveCloudWorkspace(workspaceId)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
