import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, RefObject } from 'react'
import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallTileId
} from '../../../../shared/feature-wall-tiles'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import { FEATURE_WALL_MAX_DWELL_MS } from '../../../../shared/feature-wall-telemetry'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import {
  getFeatureWallGridNavigationTarget,
  type FeatureWallNavigationKey
} from './feature-wall-grid-navigation'
import { toFeatureWallAssetUrl, useFeatureWallAssetBaseUrl } from './feature-wall-assets'
import { FeatureWallTileCard } from './FeatureWallTileCard'

const AUTO_ROTATE_MS = 3_500
const TILE_FOCUS_TELEMETRY_MS = 500
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const NAVIGATION_KEYS = new Set<string>([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End'
])

function getFeatureWallOpenSource(
  modalData: Record<string, unknown>
): FeatureWallOpenSourceTelemetry {
  const source = modalData.source
  return source === 'help_menu' || source === 'popup' ? source : 'unknown'
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return false
    }
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY)
    setPrefersReducedMotion(media.matches)
    const onChange = (event: MediaQueryListEvent): void => {
      setPrefersReducedMotion(event.matches)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return prefersReducedMotion
}

function useGridColumnCount(gridRef: RefObject<HTMLDivElement | null>, open: boolean): number {
  const [columnCount, setColumnCount] = useState(3)

  useEffect(() => {
    if (!open || !gridRef.current) {
      return
    }

    const grid = gridRef.current
    const updateColumnCount = (): void => {
      const children = Array.from(grid.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      )
      const first = children[0]
      if (!first) {
        return
      }
      const firstTop = first.offsetTop
      const nextColumnCount = children.findIndex((child) => child.offsetTop !== firstTop)
      setColumnCount(nextColumnCount === -1 ? children.length : Math.max(1, nextColumnCount))
    }

    updateColumnCount()
    const observer = new ResizeObserver(updateColumnCount)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [gridRef, open])

  return columnCount
}

export default function FeatureWallModal(): JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const isOpen = activeModal === 'feature-wall'
  const assetBaseUrl = useFeatureWallAssetBaseUrl(isOpen)
  const prefersReducedMotion = usePrefersReducedMotion()
  const [autoIndex, setAutoIndex] = useState(0)
  const [hoveredTileId, setHoveredTileId] = useState<FeatureWallTileId | null>(null)
  const [focusedTileId, setFocusedTileId] = useState<FeatureWallTileId | null>(null)
  const [rovingIndex, setRovingIndex] = useState(0)
  const tileRefs = useRef<(HTMLDivElement | null)[]>([])
  const gridRef = useRef<HTMLDivElement | null>(null)
  const columnCount = useGridColumnCount(gridRef, isOpen)
  const mediaTileIndexes = useMemo(
    () =>
      FEATURE_WALL_TILES.map((tile, index) => (isFeatureWallMediaTile(tile) ? index : -1)).filter(
        (index) => index >= 0
      ),
    []
  )
  const telemetryRef = useRef<{
    open: boolean
    openedAtMs: number
  }>({ open: false, openedAtMs: 0 })
  const manualTileId = hoveredTileId ?? focusedTileId
  const autoTileId =
    isOpen && !prefersReducedMotion && manualTileId === null
      ? FEATURE_WALL_TILES[autoIndex]?.id
      : null
  const playingTileId = manualTileId ?? autoTileId ?? null

  const assetUrlsByTileId = useMemo(() => {
    return new Map(
      FEATURE_WALL_TILES.filter(isFeatureWallMediaTile).map((tile) => [
        tile.id,
        {
          gifUrl: toFeatureWallAssetUrl(assetBaseUrl, tile.gifPath),
          posterUrl: toFeatureWallAssetUrl(assetBaseUrl, tile.posterPath)
        }
      ])
    )
  }, [assetBaseUrl])

  const emitCloseTelemetry = useCallback(() => {
    if (!telemetryRef.current.open) {
      return
    }
    const dwellMs = Math.min(
      FEATURE_WALL_MAX_DWELL_MS,
      Math.max(0, Math.round(performance.now() - telemetryRef.current.openedAtMs))
    )
    track('feature_wall_closed', {
      dwell_ms: dwellMs
    })
    telemetryRef.current.open = false
  }, [])

  useEffect(() => {
    if (isOpen && !telemetryRef.current.open) {
      telemetryRef.current = {
        open: true,
        openedAtMs: performance.now()
      }
      track('feature_wall_opened', {
        source: getFeatureWallOpenSource(modalData)
      })
      return
    }
    if (!isOpen) {
      emitCloseTelemetry()
    }
  }, [emitCloseTelemetry, isOpen, modalData])

  useEffect(() => {
    return () => emitCloseTelemetry()
  }, [emitCloseTelemetry])

  useEffect(() => {
    if (isOpen) {
      return
    }
    setHoveredTileId(null)
    setFocusedTileId(null)
    setRovingIndex(0)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || prefersReducedMotion || manualTileId !== null) {
      return
    }

    const timer = window.setInterval(() => {
      setAutoIndex((index) => {
        const currentPosition = mediaTileIndexes.indexOf(index)
        const nextPosition =
          currentPosition === -1 ? 0 : (currentPosition + 1) % mediaTileIndexes.length
        return mediaTileIndexes[nextPosition] ?? 0
      })
    }, AUTO_ROTATE_MS)
    return () => window.clearInterval(timer)
  }, [isOpen, manualTileId, mediaTileIndexes, prefersReducedMotion])

  useEffect(() => {
    if (!isOpen || manualTileId === null) {
      return
    }

    const timer = window.setTimeout(() => {
      track('feature_wall_tile_focused', {
        tile_id: manualTileId
      })
    }, TILE_FOCUS_TELEMETRY_MS)
    return () => window.clearTimeout(timer)
  }, [isOpen, manualTileId])

  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      closeModal()
    }
  }

  const handleTileKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
    if (!NAVIGATION_KEYS.has(event.key)) {
      return
    }

    event.preventDefault()
    const nextIndex = getFeatureWallGridNavigationTarget({
      currentIndex: index,
      key: event.key as FeatureWallNavigationKey,
      tileCount: FEATURE_WALL_TILES.length,
      columnCount
    })
    setRovingIndex(nextIndex)
    tileRefs.current[nextIndex]?.focus()
  }

  if (!isOpen && !telemetryRef.current.open) {
    return null
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="scrollbar-sleek max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] gap-4 overflow-y-auto p-5 sm:max-w-[1040px]"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // Why: Radix would otherwise focus the first roving tile on open,
          // which counts as user interaction and disables auto-rotation.
          const content = event.currentTarget as HTMLElement
          content.focus({ preventScroll: true })
        }}
      >
        <DialogHeader className="gap-1">
          <DialogTitle>Explore some of Orca&apos;s features</DialogTitle>
          <DialogDescription>
            Tasks, terminal, agents, browser, SSH, review, and more.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={gridRef}
          role="list"
          aria-label="Explore some of Orca's features"
          className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3"
        >
          {FEATURE_WALL_TILES.map((tile, index) => {
            const urls = assetUrlsByTileId.get(tile.id)
            return (
              <FeatureWallTileCard
                key={tile.id}
                refCallback={(node) => {
                  tileRefs.current[index] = node
                }}
                tile={tile}
                isPlaying={playingTileId === tile.id}
                tabIndex={rovingIndex === index ? 0 : -1}
                posterUrl={urls?.posterUrl ?? null}
                gifUrl={urls?.gifUrl ?? null}
                onPointerEnter={() => setHoveredTileId(tile.id)}
                onPointerLeave={() =>
                  setHoveredTileId((current) => (current === tile.id ? null : current))
                }
                onFocus={() => {
                  setFocusedTileId(tile.id)
                  setRovingIndex(index)
                }}
                onBlur={() => setFocusedTileId((current) => (current === tile.id ? null : current))}
                onKeyDown={(event) => handleTileKeyDown(event, index)}
                onOpenDocs={() => {
                  track('feature_wall_tile_clicked', {
                    tile_id: tile.id
                  })
                  void window.api.shell.openUrl(tile.docsUrl)
                }}
              />
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
