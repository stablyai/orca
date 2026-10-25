import { Axis3d, Grid3x3, Pause, Play, RotateCcw } from 'lucide-react'
import type { JSX } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { GlbModelStats } from './glb-scene'
import type { GlbModelDimensions } from './glb-scene-guides'

export type GlbModelSummary = {
  stats: GlbModelStats
  dimensions: GlbModelDimensions
  gridCellSize: number
  animationNames: string[]
}

type GlbViewerFooterProps = {
  filename: string
  summary: GlbModelSummary | null
  wireframe: boolean
  guidesVisible: boolean
  animationIndex: number
  animationPaused: boolean
  onResetView: () => void
  onWireframeChange: (enabled: boolean) => void
  onGuidesVisibleChange: (visible: boolean) => void
  onAnimationIndexChange: (index: number) => void
  onAnimationPausedChange: (paused: boolean) => void
}

const TOOLBAR_BUTTON_CLASS =
  'rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-foreground'

function formatLength(value: number): string {
  return Number(value.toPrecision(3)).toLocaleString(undefined, { maximumFractionDigits: 6 })
}

function animationLabel(name: string, index: number): string {
  return (
    name || translate('glbPreview.animationFallback', 'Animation {{index}}', { index: index + 1 })
  )
}

export function GlbViewerFooter({
  filename,
  summary,
  wireframe,
  guidesVisible,
  animationIndex,
  animationPaused,
  onResetView,
  onWireframeChange,
  onGuidesVisibleChange,
  onAnimationIndexChange,
  onAnimationPausedChange
}: GlbViewerFooterProps): JSX.Element {
  const animationNames = summary?.animationNames ?? []
  // Why the position as the value: clip names may repeat or be empty, so only the order identifies a clip.
  const animationOptions = animationNames.map((name, position) => ({
    value: String(position),
    label: animationLabel(name, position)
  }))
  return (
    <div className="flex items-center gap-4 overflow-hidden border-t px-4 py-2 text-xs text-muted-foreground">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          onClick={onResetView}
          disabled={!summary}
          title={translate('glbPreview.resetView', 'Reset view')}
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          onClick={() => onWireframeChange(!wireframe)}
          disabled={!summary}
          aria-pressed={wireframe}
          title={translate('glbPreview.wireframe', 'Wireframe')}
        >
          <Grid3x3 size={14} />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON_CLASS}
          onClick={() => onGuidesVisibleChange(!guidesVisible)}
          disabled={!summary}
          aria-pressed={guidesVisible}
          title={translate('glbPreview.guides', 'Grid and axes')}
        >
          <Axis3d size={14} />
        </button>
      </div>
      {animationNames.length > 0 && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className={TOOLBAR_BUTTON_CLASS}
            onClick={() => onAnimationPausedChange(!animationPaused)}
            title={
              animationPaused
                ? translate('glbPreview.playAnimation', 'Play animation')
                : translate('glbPreview.pauseAnimation', 'Pause animation')
            }
          >
            {animationPaused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          {animationNames.length > 1 ? (
            <Select
              value={String(animationIndex)}
              onValueChange={(value) => onAnimationIndexChange(Number(value))}
            >
              <SelectTrigger
                size="sm"
                className="max-w-40"
                aria-label={translate('glbPreview.animation', 'Animation')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {animationOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="max-w-40 truncate">{animationLabel(animationNames[0], 0)}</span>
          )}
        </div>
      )}
      <span className="min-w-0 truncate" title={filename}>
        {filename}
      </span>
      {summary && (
        <>
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {translate('glbPreview.stats', '{{vertices}} vertices · {{triangles}} triangles', {
              vertices: summary.stats.vertices.toLocaleString(),
              triangles: summary.stats.triangles.toLocaleString()
            })}
          </span>
          <span
            className="shrink-0 whitespace-nowrap tabular-nums"
            title={translate('glbPreview.dimensionsTitle', 'Width × height × depth, in meters')}
          >
            {translate('glbPreview.dimensions', '{{width}} × {{height}} × {{depth}} m', {
              width: formatLength(summary.dimensions.width),
              height: formatLength(summary.dimensions.height),
              depth: formatLength(summary.dimensions.depth)
            })}
          </span>
          {guidesVisible && (
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {translate('glbPreview.gridCell', 'Grid {{size}} m', {
                size: formatLength(summary.gridCellSize)
              })}
            </span>
          )}
        </>
      )}
    </div>
  )
}
