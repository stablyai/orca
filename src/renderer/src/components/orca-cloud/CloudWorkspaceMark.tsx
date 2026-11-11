import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { HostGlyph } from '@/components/host-row-icon'
import { FOCUS_RING } from './cloud-focus'
import { cloudStateLabel } from './cloud-state-copy'
import { CloudWorkspaceStatusPanel } from './CloudWorkspaceStatusPanel'
import { useCloudStatusPolling, useCloudWorkspaceView } from './use-cloud-workspace-view'
import { useCloudPanelActions } from './use-cloud-panel-actions'
import { onCloudSyncFocusRequest } from '@/lib/orca-cloud/cloud-sync-store'

const PANEL_POLL_MS = 5_000
const HOVER_OPEN_MS = 250
const HOVER_CLOSE_MS = 180
const CARD_GAP_PX = 8

/**
 * The card opens beside the sidebar, not over the row it describes: from the mark to the sidebar's
 * right edge, plus a gap. Outside the sidebar (fixtures, other hosts) it sits just right of the mark.
 */
export function cloudCardSideOffset(mark: HTMLElement | null): number {
  const sidebar = mark?.closest('[data-left-sidebar]')
  if (!mark || !sidebar) {
    return 10
  }
  return Math.max(
    10,
    sidebar.getBoundingClientRect().right - mark.getBoundingClientRect().right + CARD_GAP_PX
  )
}

/**
 * Sidebar mark for an Orca Cloud workspace: the Cloud host glyph with its live state as a corner badge,
 * in the same 12px slot as every other host glyph so titles align.
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
  const mark = useRef<HTMLButtonElement | null>(null)
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
  // "Mirror to this computer…" in the workspace menu opens this panel on its sync section.
  useEffect(
    () =>
      onCloudSyncFocusRequest(workspaceId, () => {
        clearTimer()
        setOpen('pinned')
      }),
    [workspaceId, clearTimer]
  )
  useCloudStatusPolling(workspaceId, PANEL_POLL_MS, open !== null)
  const close = useCallback(() => setOpen(null), [])
  const actions = useCloudPanelActions(workspaceId, close)
  // Esc closes the innermost layer first: the card's sub-panel, then the card.
  const escapeInner = useRef<(() => boolean) | null>(null)
  // Pointer or focus inside (the card, its sub-panel or its ⋯ menu) keeps a hover preview open.
  const pin = useCallback(() => {
    clearTimer()
    setOpen((current) => (current === 'hover' ? 'pinned' : current))
  }, [clearTimer])
  const label = t('orcaCloudWorkspace.cloudMarkLabel', 'Cloud workspace · {{state}}', {
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
          ref={mark}
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
            // 24px hit area around the 12px glyph, without changing the row's layout.
            "relative inline-flex size-3 shrink-0 items-center rounded-sm text-muted-foreground after:absolute after:-inset-1.5 after:content-['']",
            'hover:text-foreground',
            FOCUS_RING
          )}
        >
          <HostGlyph kind="orca-cloud" size={12} state={view.state} className="text-inherit" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        side="right"
        align="start"
        sideOffset={open ? cloudCardSideOffset(mark.current) : 10}
        focusRing
        className="w-72"
        aria-label={label}
        tabIndex={-1}
        onPointerEnter={() => clearTimer()}
        onPointerLeave={hoverOut}
        onPointerDownCapture={pin}
        onFocusCapture={(event) => {
          // The preview's own open focus lands on the content, not inside it.
          if (event.target !== content.current) {
            pin()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (escapeInner.current?.()) {
            event.preventDefault()
          }
        }}
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
        {/* Taller than a short window once the sync section is open: scroll instead of clipping. */}
        <div className="scrollbar-sleek max-h-(--radix-popover-content-available-height) overflow-y-auto p-3">
          <CloudWorkspaceStatusPanel
            workspaceId={workspaceId}
            state={view.state}
            entry={view.entry}
            pending={view.pending}
            actions={actions}
            escapeRef={escapeInner}
            onMenuOpenChange={(menuOpen) => (menuOpen ? pin() : undefined)}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
