import { useEffect, useState } from 'react'
import type { JSX, KeyboardEvent } from 'react'
import { ExternalLink } from 'lucide-react'
import type { FeatureWallTile } from '../../../../shared/feature-wall-tiles'
import { cn } from '@/lib/utils'

export function FeatureWallTileCard(props: {
  tile: FeatureWallTile
  isPlaying: boolean
  tabIndex: number
  posterUrl: string | null
  gifUrl: string | null
  refCallback: (node: HTMLDivElement | null) => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  onOpenDocs: () => void
}): JSX.Element {
  const {
    tile,
    isPlaying,
    tabIndex,
    posterUrl,
    gifUrl,
    refCallback,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    onKeyDown,
    onOpenDocs
  } = props
  const [posterFailed, setPosterFailed] = useState(false)
  const [gifFailed, setGifFailed] = useState(false)
  const showPoster = posterUrl !== null && !posterFailed
  const showGif = tile.kind === 'media' && isPlaying && gifUrl !== null && !gifFailed
  const showMockup = tile.kind === 'agent-status-mockup'
  const textOnly = !showMockup && !showGif && !showPoster

  useEffect(() => {
    setPosterFailed(false)
    setGifFailed(false)
  }, [gifUrl, posterUrl])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown(event)
    if (event.defaultPrevented) {
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    event.preventDefault()
    onOpenDocs()
  }

  return (
    <div
      ref={refCallback}
      role="listitem"
      aria-label={`Open docs for ${tile.title}. ${tile.caption}`}
      tabIndex={tabIndex}
      data-feature-wall-tile-id={tile.id}
      className={cn(
        'group min-w-0 cursor-pointer overflow-hidden rounded-md border border-border/70 bg-card text-left shadow-xs outline-none transition-[border-color,box-shadow,transform]',
        'hover:border-ring/60',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
      )}
      onClick={onOpenDocs}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={handleKeyDown}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        {showMockup ? <AgentStatusMockup /> : null}
        {showPoster ? (
          <img
            src={posterUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full object-cover"
            draggable={false}
            onError={() => setPosterFailed(true)}
          />
        ) : null}
        {showGif ? (
          <img
            src={gifUrl}
            alt=""
            aria-hidden
            className="absolute inset-0 size-full object-cover"
            draggable={false}
            onError={() => setGifFailed(true)}
          />
        ) : null}
        {textOnly ? (
          <div className="flex size-full flex-col justify-end gap-1 bg-muted p-4">
            <div className="text-sm font-semibold leading-tight text-foreground">{tile.title}</div>
            <div className="text-xs leading-snug text-muted-foreground">{tile.caption}</div>
          </div>
        ) : null}
      </div>
      <div className={cn('space-y-1 p-3', textOnly && 'invisible')}>
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
          <span className="truncate">{tile.title}</span>
          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </div>
        <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{tile.caption}</p>
      </div>
    </div>
  )
}

function AgentStatusMockup(): JSX.Element {
  return (
    <div className="flex size-full flex-col justify-center gap-2 bg-muted p-5">
      <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground">● Claude Code</span> · finished tests, pushing
      </div>
      <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span className="text-foreground">● Codex</span> · refactoring handlers
      </div>
      <div className="rounded-md border border-border bg-accent px-3 py-2 font-mono text-[11px] text-accent-foreground">
        <span className="font-medium text-foreground">● OpenCode</span> · blocked on API response
      </div>
    </div>
  )
}
