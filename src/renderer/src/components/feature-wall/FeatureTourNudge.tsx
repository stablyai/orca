import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { PlayCircle, X } from 'lucide-react'
import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallMediaTile
} from '../../../../shared/feature-wall-tiles'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { toFeatureWallAssetUrl, useFeatureWallAssetBaseUrl } from './feature-wall-assets'

const FEATURE_TOUR_NUDGE_TILE = FEATURE_WALL_TILES.find(
  (tile): tile is FeatureWallMediaTile => tile.id === 'tile-03' && isFeatureWallMediaTile(tile)
)

export function FeatureTourNudge(): JSX.Element | null {
  const visible = useAppStore((s) => s.featureTourNudgeVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const dismissFeatureTourNudge = useAppStore((s) => s.dismissFeatureTourNudge)
  const openModal = useAppStore((s) => s.openModal)
  const shouldRender = visible && activeModal !== 'feature-wall'
  const assetBaseUrl = useFeatureWallAssetBaseUrl(shouldRender)
  const [mediaFailed, setMediaFailed] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState(false)
  const gifUrl = FEATURE_TOUR_NUDGE_TILE
    ? toFeatureWallAssetUrl(assetBaseUrl, FEATURE_TOUR_NUDGE_TILE.gifPath)
    : null
  const posterUrl = FEATURE_TOUR_NUDGE_TILE
    ? toFeatureWallAssetUrl(assetBaseUrl, FEATURE_TOUR_NUDGE_TILE.posterPath)
    : null
  const mediaUrl = gifUrl ?? posterUrl
  const updateCardVisible = updateStatus.state !== 'idle' && updateStatus.state !== 'not-available'

  useEffect(() => {
    setMediaFailed(false)
    setMediaLoaded(false)
  }, [mediaUrl])

  useEffect(() => {
    if (!shouldRender) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        dismissFeatureTourNudge()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismissFeatureTourNudge, shouldRender])

  if (!shouldRender || !FEATURE_TOUR_NUDGE_TILE) {
    return null
  }

  const handleOpenTour = (): void => {
    openModal('feature-wall', { source: 'popup' })
  }

  return (
    <div
      className={cn(
        'fixed right-4 z-40 w-[360px] max-w-[calc(100vw-32px)]',
        'max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto',
        // Why: UpdateCard owns bottom-10 when visible; keep this education
        // card nearby without covering update actions.
        updateCardVisible ? 'bottom-[220px]' : 'bottom-10'
      )}
    >
      <Card
        className="cursor-pointer gap-0 overflow-hidden py-0"
        role="complementary"
        aria-label="Explore some of Orca's features"
        onClick={handleOpenTour}
      >
        <div className="flex flex-col gap-3 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                Explore some of Orca&apos;s features
              </div>
              <h3 className="truncate text-sm font-semibold">{FEATURE_TOUR_NUDGE_TILE.title}</h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={(event) => {
                event.stopPropagation()
                dismissFeatureTourNudge()
              }}
              aria-label="Dismiss feature tour"
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <button
            type="button"
            className="relative block aspect-[16/9] w-full overflow-hidden rounded-md bg-muted text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={handleOpenTour}
            aria-label="Open feature tour"
          >
            {mediaUrl && !mediaLoaded && !mediaFailed ? (
              <div className="absolute inset-0 animate-pulse bg-muted/50" />
            ) : null}
            {mediaUrl && !mediaFailed ? (
              <img
                src={mediaUrl}
                alt=""
                className={cn(
                  'size-full object-cover',
                  mediaLoaded ? '' : 'absolute inset-0 opacity-0'
                )}
                draggable={false}
                onLoad={() => setMediaLoaded(true)}
                onError={() => setMediaFailed(true)}
              />
            ) : (
              <div className="flex size-full items-end p-3 text-sm font-semibold text-foreground">
                {FEATURE_TOUR_NUDGE_TILE.title}
              </div>
            )}
          </button>

          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {FEATURE_TOUR_NUDGE_TILE.caption}
          </p>

          <Button variant="default" size="sm" className="w-full gap-1.5" onClick={handleOpenTour}>
            <PlayCircle className="size-3.5" />
            Open tour
          </Button>
        </div>
      </Card>
    </div>
  )
}
