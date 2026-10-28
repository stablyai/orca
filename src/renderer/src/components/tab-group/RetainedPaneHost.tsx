import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { tabGroupBodyAnchorName } from './tab-group-body-anchor'
import { subscribeTabGroupBodyRect, type TabGroupBodyRect } from './tab-group-body-geometry'
import { UNFOCUSED_SPLIT_GROUP_OPACITY } from './split-group-dim'
import { useWorkspaceViewProjection } from '../workspace-grid-view/workspace-view-projection'

const HAS_CSS_ANCHOR_POSITIONING =
  typeof CSS !== 'undefined' &&
  CSS.supports('position-anchor', '--orca-terminal-overlay-probe') &&
  CSS.supports('top', 'anchor(--orca-terminal-overlay-probe top)') &&
  CSS.supports('width', 'anchor-size(--orca-terminal-overlay-probe width)')
const MIN_OVERLAY_FIT_WIDTH_PX = 48
const MIN_OVERLAY_FIT_HEIGHT_PX = 24

function shouldUseCssAnchorPositioning(): boolean {
  return (
    HAS_CSS_ANCHOR_POSITIONING &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

type RetainedPaneHostProps = {
  groupId: string | undefined
  isVisible: boolean
  measureWhileHidden?: boolean
  fitTerminal?: boolean
  /** Unfocused side of a split: overlays sit outside the group's DOM, so they take its dim here. */
  dimmed?: boolean
  onFocusOwningGroup?: (groupId: string) => void
  children: React.ReactNode
  'data-terminal-overlay-tab-id'?: string
  'data-structured-agent-session-overlay-tab-id'?: string
}

export function RetainedPaneHost({
  groupId,
  isVisible,
  measureWhileHidden = false,
  fitTerminal = false,
  dimmed = false,
  onFocusOwningGroup,
  children,
  ...identity
}: RetainedPaneHostProps): React.JSX.Element {
  const viewProjection = useWorkspaceViewProjection()
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [measuredFallbackRect, setMeasuredFallbackRect] = useState<TabGroupBodyRect | null>(null)
  // Why: a hidden host renders display:none, so it has no use for group geometry until shown.
  const measuresFallbackRect =
    groupId !== undefined && !shouldUseCssAnchorPositioning() && (isVisible || measureWhileHidden)
  // Measure before mounting child xterms: child layout effects run first and would fit a placeholder rectangle.
  const [awaitsFirstFallbackRect, setAwaitsFirstFallbackRect] = useState(measuresFallbackRect)
  useLayoutEffect(() => {
    const container = overlayRef.current?.parentElement
    if (!measuresFallbackRect || groupId === undefined || !container) {
      setAwaitsFirstFallbackRect(false)
      return
    }
    return subscribeTabGroupBodyRect(groupId, container, (rect) => {
      setMeasuredFallbackRect(rect)
      setAwaitsFirstFallbackRect(false)
    })
  }, [groupId, measuresFallbackRect])

  useLayoutEffect(() => {
    if (!fitTerminal || !isVisible || !anchorName) {
      return
    }
    const dispatchFitIfMeasurable = (): void => {
      const rect = overlayRef.current?.getBoundingClientRect()
      if (
        !rect ||
        rect.width < MIN_OVERLAY_FIT_WIDTH_PX ||
        rect.height < MIN_OVERLAY_FIT_HEIGHT_PX
      ) {
        return
      }
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    }

    // Wait for real overlay dimensions after visibility changes so PTYs cannot remain fitted to a stale tiny width.
    const frameId = requestAnimationFrame(() => {
      dispatchFitIfMeasurable()
    })
    const retryId = window.setTimeout(() => {
      dispatchFitIfMeasurable()
    }, 50)
    const settledRetryId = window.setTimeout(() => {
      dispatchFitIfMeasurable()
    }, 150)
    return () => {
      cancelAnimationFrame(frameId)
      window.clearTimeout(retryId)
      window.clearTimeout(settledRetryId)
    }
  }, [anchorName, fitTerminal, isVisible, measuredFallbackRect])

  const visibleOpacity = dimmed ? UNFOCUSED_SPLIT_GROUP_OPACITY : 1
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName && shouldUseCssAnchorPositioning()
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            // An unresolved anchor must stay clipped instead of painting a content-sized pane.
            top: `anchor(${anchorName} top, 0px)`,
            left: `anchor(${anchorName} left, 0px)`,
            width: `anchor-size(${anchorName} width, 0px)`,
            height: `anchor-size(${anchorName} height, 0px)`,
            display: isVisible || measureWhileHidden ? 'flex' : 'none',
            opacity: isVisible ? visibleOpacity : 0,
            pointerEvents: isVisible ? 'auto' : 'none'
          }
        : anchorName
          ? {
              // Without CSS anchors, measure the group body so terminals fit real geometry without covering its tab strip.
              position: 'absolute',
              top: measuredFallbackRect?.top ?? 32,
              left: measuredFallbackRect?.left ?? 0,
              width: measuredFallbackRect?.width ?? '100%',
              height: measuredFallbackRect?.height ?? 'calc(100% - 32px)',
              display: isVisible || measureWhileHidden ? 'flex' : 'none',
              opacity: isVisible ? visibleOpacity : 0,
              pointerEvents: isVisible ? 'auto' : 'none'
            }
          : {
              position: 'absolute',
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              display: 'none',
              pointerEvents: 'none'
            },
    [anchorName, isVisible, measuredFallbackRect, measureWhileHidden, visibleOpacity]
  )
  const focusGroup = useCallback(() => {
    if (groupId !== undefined && onFocusOwningGroup) {
      onFocusOwningGroup(groupId)
    }
  }, [groupId, onFocusOwningGroup])

  return (
    <div
      ref={overlayRef}
      style={style}
      // Pane-local layers cannot compete with app notifications or escape their split rectangle.
      className="isolate z-10 min-h-0 min-w-0 overflow-hidden"
      data-retained-pane-host=""
      {...identity}
      inert={!isVisible}
      aria-hidden={!isVisible}
      onPointerDown={viewProjection ? undefined : focusGroup}
      onPointerDownCapture={viewProjection ? focusGroup : undefined}
      onFocusCapture={focusGroup}
    >
      {awaitsFirstFallbackRect ? null : children}
    </div>
  )
}
