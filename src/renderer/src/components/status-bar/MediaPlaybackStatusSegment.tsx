import { Apple, Pause, Play, Square } from 'lucide-react'
import React, { useEffect, useState } from 'react'
import type { MediaPlaybackStatus } from '../../../../shared/media-playback-status'
import { SpotifyIcon } from '@/components/icons/SpotifyIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

const POLL_INTERVAL_MS = 3_000

function playerLabel(status: MediaPlaybackStatus): string {
  return status.player === 'spotify' ? 'Spotify' : 'Apple Music'
}

function stateLabel(status: MediaPlaybackStatus): string {
  if (status.state === 'playing') {
    return translate('statusBar.mediaPlayback.playing', 'Playing')
  }
  if (status.state === 'paused') {
    return translate('statusBar.mediaPlayback.paused', 'Paused')
  }
  return translate('statusBar.mediaPlayback.stopped', 'Stopped')
}

function trackLabel(status: MediaPlaybackStatus): string {
  if (status.artist && status.track) {
    return `${status.artist} — ${status.track}`
  }
  return (
    status.track || status.artist || translate('statusBar.mediaPlayback.noTrack', 'No track info')
  )
}

function PlaybackIcon({ state }: Pick<MediaPlaybackStatus, 'state'>): React.JSX.Element {
  if (state === 'playing') {
    return <Play className="size-3 shrink-0" aria-hidden />
  }
  if (state === 'paused') {
    return <Pause className="size-3 shrink-0" aria-hidden />
  }
  return <Square className="size-3 shrink-0" aria-hidden />
}

function PlayerIcon({ player }: Pick<MediaPlaybackStatus, 'player'>): React.JSX.Element {
  return (
    <span
      data-media-player={player}
      className="inline-flex shrink-0 items-center text-muted-foreground"
      aria-hidden
    >
      {player === 'spotify' ? <SpotifyIcon className="size-3.5" /> : <Apple className="size-3.5" />}
    </span>
  )
}

export function MediaPlaybackStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const [status, setStatus] = useState<MediaPlaybackStatus | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const refresh = async (): Promise<void> => {
      try {
        const nextStatus = await window.api.mediaPlayback.getStatus()
        if (!disposed) {
          setStatus(nextStatus)
        }
      } catch {
        if (!disposed) {
          setStatus(null)
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS)
        }
      }
    }

    void refresh()
    return () => {
      disposed = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [])

  if (!status) {
    return null
  }

  const source = playerLabel(status)
  const track = trackLabel(status)
  const description = `${source} · ${stateLabel(status)} · ${track}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          tabIndex={0}
          aria-label={description}
          className="inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
            <PlayerIcon player={status.player} />
            <PlaybackIcon state={status.state} />
          </span>
          {!iconOnly ? (
            <span className={`${compact ? 'max-w-40' : 'max-w-72'} min-w-0 truncate text-xs`}>
              <span data-media-track-title className="font-semibold text-foreground">
                {status.track ||
                  status.artist ||
                  translate('statusBar.mediaPlayback.noTrack', 'No track info')}
              </span>
              {status.track && status.artist ? (
                <span data-media-track-artist className="text-muted-foreground">
                  {' — '}
                  {status.artist}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {description}
      </TooltipContent>
    </Tooltip>
  )
}
