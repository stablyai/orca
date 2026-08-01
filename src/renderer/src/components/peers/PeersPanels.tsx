import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDndMonitor, useDroppable } from '@dnd-kit/core'
import { XIcon } from 'lucide-react'
import { RemoteTerminalPanel } from '@/components/peer-collab/RemoteTerminalPanel'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { dockZoneOverlayRect, type PeersDockZone } from './peers-dock-zone'
import { isSameTarget, pruneUngrantedKeepAlive, visitPeersKeepAlive } from './peers-panel-lru'
import { resolvePeersDockDrop } from './peers-panels-dock-drop'
import {
  computePeersLayoutRects,
  findSplitBoxAtPath,
  ratioFromPointerInSplitBox,
  type PeersLayoutRect,
  type PeersLayoutDivider
} from './peers-split-rects'
import { collectLeaves, leafKey } from './peers-split-tree'

function isTargetGranted(hosts: PeerHostConnection[], target: RemoteTerminalTarget): boolean {
  const host = hosts.find((h) => h.hostId === target.hostId && h.status.state === 'connected')
  return Boolean(host?.terminals.some((terminal) => terminal.handle === target.handle))
}

function toPx(value: number): string {
  return `${value}px`
}

/** One rendered pane, doubling as a dnd-kit dock-drop target for tab drags — disabled while hidden so overlapping hidden panes never compete for drop collisions. */
function PeersPanelDropTarget({
  panelKey,
  visible,
  isFocused,
  showCloseButton,
  style,
  onFocus,
  onClose,
  children
}: {
  panelKey: string
  visible: boolean
  isFocused: boolean
  showCloseButton: boolean
  style: React.CSSProperties
  onFocus: () => void
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef } = useDroppable({
    id: `peers-dock:${panelKey}`,
    disabled: !visible,
    data: { type: 'peers-dock-pane', leafKey: panelKey }
  })
  return (
    <div
      ref={setNodeRef}
      className={`group absolute overflow-hidden ${isFocused ? 'ring-1 ring-ring' : ''}`}
      style={style}
      onMouseDown={onFocus}
    >
      {children}
      {showCloseButton ? (
        <button
          type="button"
          className="pointer-events-none absolute top-1 right-1 z-10 flex size-5 items-center justify-center rounded-xs bg-background/80 text-muted-foreground opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-ring/20"
          aria-label={translate('auto.components.peers.PeersPanels.closePane', 'Close pane')}
          onMouseDown={(mouseEvent) => mouseEvent.stopPropagation()}
          onClick={(clickEvent) => {
            clickEvent.stopPropagation()
            onClose()
          }}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  )
}

/**
 * Renders the visible peer terminal pane(s). Every target visited this session
 * stays mounted (up to peers-panel-lru's cap) so switching tabs doesn't drop
 * the xterm buffer or the host subscription. With no split tree, only the
 * primary pane is shown (visibility toggle); with a tree, every leaf gets an
 * absolutely-positioned rect from peers-split-rects and the rest stay hidden —
 * the same DOM node per target keeps its key across splits/moves/ratio
 * changes so RemoteTerminalPanel (and its xterm instance) never remounts.
 */
export function PeersPanels({
  hosts,
  primary
}: {
  hosts: PeerHostConnection[]
  primary: RemoteTerminalTarget
}): React.JSX.Element {
  const [mounted, setMounted] = useState<RemoteTerminalTarget[]>([])
  const peersLayout = useAppStore((s) => s.peersLayout)
  const setPeersPageTarget = useAppStore((s) => s.setPeersPageTarget)
  const setPeersPaneRatio = useAppStore((s) => s.setPeersPaneRatio)
  const closePeersPane = useAppStore((s) => s.closePeersPane)
  const splitPeersPane = useAppStore((s) => s.splitPeersPane)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [dockPreview, setDockPreview] = useState<{ leafKey: string; zone: PeersDockZone } | null>(
    null
  )

  // Why: a tab dragged from PeersPageTabStrip shares PeersPage's DndContext, so
  // docking a preview/drop is driven by that ambient context rather than a local one.
  useDndMonitor({
    onDragMove: ({ active, over }) => {
      const resolved = resolvePeersDockDrop({
        activeData: active.data.current as
          | { type?: string; tab?: RemoteTerminalTarget }
          | undefined,
        activeTranslatedRect: active.rect.current.translated,
        overData: over?.data.current as { type?: string; leafKey?: string } | undefined,
        overRect: over?.rect
      })
      setDockPreview(resolved ? { leafKey: resolved.atLeafKey, zone: resolved.side } : null)
    },
    onDragEnd: ({ active, over }) => {
      setDockPreview(null)
      const resolved = resolvePeersDockDrop({
        activeData: active.data.current as
          | { type?: string; tab?: RemoteTerminalTarget }
          | undefined,
        activeTranslatedRect: active.rect.current.translated,
        overData: over?.data.current as { type?: string; leafKey?: string } | undefined,
        overRect: over?.rect
      })
      if (resolved) {
        splitPeersPane(resolved.atLeafKey, resolved.side, resolved.newTarget)
      }
    },
    onDragCancel: () => setDockPreview(null)
  })

  // Why: ResizeObserver's first callback is async in real browsers, so read the
  // initial size synchronously to avoid a one-frame single-pane fallback flash.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const rect = el.getBoundingClientRect()
    setSize((prev) =>
      prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height }
    )
  }, [])

  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setMounted((prev) => {
      const granted = pruneUngrantedKeepAlive(prev, (target) => isTargetGranted(hosts, target))
      const treeLeaves = peersLayout ? collectLeaves(peersLayout) : []
      const pinned = treeLeaves.length > 0 ? treeLeaves : [primary]
      const visited = isTargetGranted(hosts, primary)
        ? visitPeersKeepAlive(granted, primary, pinned)
        : granted
      // Why: visitPeersKeepAlive only adds/reorders `primary` — every other tree
      // leaf must also be mounted, since they're rendered simultaneously.
      const missingLeaves = treeLeaves.filter(
        (leaf) =>
          isTargetGranted(hosts, leaf) &&
          !visited.some((mountedTarget) => isSameTarget(mountedTarget, leaf))
      )
      return missingLeaves.length > 0 ? [...visited, ...missingLeaves] : visited
    })
  }, [hosts, primary, peersLayout])

  const rects =
    peersLayout && size.width > 0 && size.height > 0
      ? computePeersLayoutRects(peersLayout, size)
      : null
  const paneRectByKey = new Map(rects?.panes.map((pane) => [pane.key, pane.rect]) ?? [])

  // Why: with no split tree there's no rect entry for the single pane — it's the whole container.
  const dockPreviewPaneRect: PeersLayoutRect | undefined = dockPreview
    ? (paneRectByKey.get(dockPreview.leafKey) ??
      (dockPreview.leafKey === leafKey(primary) ? { x: 0, y: 0, ...size } : undefined))
    : undefined
  const dockPreviewOverlayRect =
    dockPreview && dockPreviewPaneRect
      ? dockZoneOverlayRect(dockPreviewPaneRect, dockPreview.zone)
      : null

  // Why: pointercancel (touch/pen interruption) never fires pointerup, and an
  // unmount mid-drag would leave the window listeners attached forever.
  const endDividerDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => endDividerDragRef.current?.(), [])

  const startDividerDrag =
    (divider: PeersLayoutDivider) =>
    (pointerEvent: React.PointerEvent): void => {
      if (!peersLayout) {
        return
      }
      pointerEvent.preventDefault()
      const container = containerRef.current
      if (!container) {
        return
      }
      const splitBox = findSplitBoxAtPath(peersLayout, size, divider.path)
      if (!splitBox) {
        return
      }
      endDividerDragRef.current?.()
      const containerRect = container.getBoundingClientRect()
      const onMove = (moveEvent: PointerEvent): void => {
        const ratio = ratioFromPointerInSplitBox(splitBox, divider.direction, {
          x: moveEvent.clientX - containerRect.left,
          y: moveEvent.clientY - containerRect.top
        })
        setPeersPaneRatio(divider.path, ratio)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        endDividerDragRef.current = null
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      endDividerDragRef.current = onUp
    }

  return (
    <div ref={containerRef} className="relative min-h-0 w-full flex-1">
      {mounted.map((target) => {
        const key = leafKey(target)
        const rect = rects ? paneRectByKey.get(key) : undefined
        const visible = rects ? Boolean(rect) : isSameTarget(target, primary)
        const isFocused = Boolean(rects) && isSameTarget(target, primary)
        return (
          <PeersPanelDropTarget
            key={key}
            panelKey={key}
            visible={visible}
            isFocused={isFocused}
            showCloseButton={Boolean(peersLayout)}
            style={
              rect
                ? {
                    left: toPx(rect.x),
                    top: toPx(rect.y),
                    width: toPx(rect.width),
                    height: toPx(rect.height),
                    visibility: 'visible',
                    zIndex: 1
                  }
                : {
                    inset: 0,
                    visibility: visible ? 'visible' : 'hidden',
                    zIndex: visible ? 1 : 0
                  }
            }
            onFocus={() => {
              if (peersLayout) {
                setPeersPageTarget(target)
              }
            }}
            onClose={() => closePeersPane(key)}
          >
            <RemoteTerminalPanel
              hostId={target.hostId}
              terminalHandle={target.handle}
              hidden={!visible}
            />
          </PeersPanelDropTarget>
        )
      })}
      {dockPreviewOverlayRect ? (
        <div
          className="pointer-events-none absolute z-30 bg-ring/20"
          style={{
            left: toPx(dockPreviewOverlayRect.x),
            top: toPx(dockPreviewOverlayRect.y),
            width: toPx(dockPreviewOverlayRect.width),
            height: toPx(dockPreviewOverlayRect.height)
          }}
        />
      ) : null}
      {rects?.dividers.map((divider) => (
        <div
          key={`divider:${divider.path.join('.')}`}
          className={`absolute z-20 transition-colors hover:bg-ring/20 active:bg-ring/30 ${
            divider.direction === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'
          }`}
          style={{
            left: toPx(divider.rect.x),
            top: toPx(divider.rect.y),
            width: toPx(divider.rect.width),
            height: toPx(divider.rect.height)
          }}
          onPointerDown={startDividerDrag(divider)}
        />
      ))}
    </div>
  )
}
