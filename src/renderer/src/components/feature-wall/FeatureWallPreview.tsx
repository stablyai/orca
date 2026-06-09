import { useState } from 'react'
import type { JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  getFeatureWallMediaTile,
  type FeatureWallWorkflow
} from '../../../../shared/feature-wall-workflows'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import { track } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'

export function PreviewMedia(props: {
  posterUrl: string | null
  gifUrl: string | null
  showGif: boolean
  workflowTitle: string
}): JSX.Element {
  const { posterUrl, gifUrl, showGif, workflowTitle } = props
  const [posterFailed, setPosterFailed] = useState(false)
  const [gifFailed, setGifFailed] = useState(false)
  const renderPoster = posterUrl !== null && !posterFailed
  const renderGif = showGif && gifUrl !== null && !gifFailed

  return (
    <figure
      className="relative aspect-[16/10] w-full overflow-hidden rounded-md border border-border bg-muted"
      aria-hidden
    >
      {renderPoster ? (
        <img
          src={posterUrl ?? undefined}
          alt=""
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          onError={() => setPosterFailed(true)}
        />
      ) : null}
      {renderGif ? (
        <img
          src={gifUrl ?? undefined}
          alt=""
          className="absolute inset-0 size-full object-cover"
          draggable={false}
          onError={() => setGifFailed(true)}
        />
      ) : null}
      {!renderPoster && !renderGif ? (
        <div className="absolute inset-0 flex items-end p-4">
          <span className="text-sm font-semibold text-foreground">{workflowTitle}</span>
        </div>
      ) : null}
    </figure>
  )
}

export function RelatedFeatures(props: {
  workflow: FeatureWallWorkflow
  source: FeatureWallOpenSourceTelemetry
}): JSX.Element | null {
  const { workflow, source } = props
  const items = workflow.relatedTileIds
    .map((id) => getFeatureWallMediaTile(id))
    .filter((tile): tile is NonNullable<typeof tile> => tile !== null)
  if (items.length === 0) {
    return null
  }
  return (
    <div className="border-t border-border pt-3.5">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate("auto.components.feature.wall.FeatureWallPreview.a666384798", "Also in this workflow")}</h4>
      <ul className="flex flex-col gap-1" role="list">
        {items.map((tile) => (
          <li key={tile.id}>
            <button
              type="button"
              onClick={() => {
                track('feature_wall_docs_clicked', {
                  group_id: workflow.id,
                  tile_id: tile.id,
                  source
                })
                track('feature_wall_tile_clicked', { tile_id: tile.id })
                void window.api.shell.openUrl(tile.docsUrl)
              }}
              className="inline-flex items-center gap-1.5 text-left text-[13px] hover:underline hover:underline-offset-2"
            >
              {tile.title}
              <ChevronRight className="size-3 text-muted-foreground" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
