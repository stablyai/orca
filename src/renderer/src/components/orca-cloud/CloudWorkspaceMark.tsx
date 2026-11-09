import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Cloud } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { CloudStateDot } from './CloudStateDot'
import { FOCUS_RING } from './cloud-focus'
import { cloudStateLabel } from './cloud-state-copy'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import { useCloudStatusPolling, useCloudWorkspaceView } from './use-cloud-workspace-view'
import { useCloudPanelActions } from './use-cloud-panel-actions'

const PANEL_POLL_MS = 5_000
const HOVER_OPEN_MS = 250
const HOVER_CLOSE_MS = 180

/**
 * Sidebar mark for an Orca Cloud workspace: a cloud glyph with its live state dot beside it.
 * Hover previews the status panel; click or Enter pins it and moves focus into it.
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
  return (
    <CloudWorkspaceMarkInner workspaceId={workspaceId} view={view} onPointerDown={onPointerDown} />
  )
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
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
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
  const close = useCallback(() => setOpen(null), [])
  const actions = useCloudPanelActions(workspaceId, close)
  const label = t('orcaCloudWorkspace.sandboxMarkLabel', 'Sandbox: {{state}}', {
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
              // Clicking (or Enter on) a hover preview pins it and moves focus in, instead of
              // toggling it closed.
              event.preventDefault()
              clearTimer()
              setOpen('pinned')
              content.current?.focus()
            }
          }}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          className={cn(
            // 24px hit area around the 16px mark, without changing the row's layout.
            "relative inline-flex h-4 shrink-0 items-center gap-[3px] rounded px-px text-muted-foreground after:absolute after:-inset-1 after:content-['']",
            'hover:text-foreground',
            FOCUS_RING
          )}
        >
          <Cloud className="size-3" aria-hidden="true" />
          <CloudStateDot state={view.state} size="md" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        side="right"
        align="start"
        sideOffset={10}
        className={cn('w-72 p-3', FOCUS_RING)}
        aria-label={label}
        tabIndex={-1}
        onPointerEnter={() => clearTimer()}
        onPointerLeave={hoverOut}
        onOpenAutoFocus={(event) => {
          // Hover previews keep focus in the sidebar; a pinned panel takes focus itself (not
          // its first action, so Enter can't act by accident).
          event.preventDefault()
          if (open !== 'hover') {
            content.current?.focus()
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <CloudWorkspaceStatusPanel
          workspaceId={workspaceId}
          state={view.state}
          entry={view.entry}
          pending={view.pending}
          actions={actions}
        />
      </PopoverContent>
    </Popover>
  )
}
