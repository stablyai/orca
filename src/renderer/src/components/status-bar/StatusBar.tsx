import { RefreshCw } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'

// ---------------------------------------------------------------------------
// Mini progress bar (shows remaining capacity, grey)
// ---------------------------------------------------------------------------

function MiniBar({ leftPct }: { leftPct: number }): React.JSX.Element {
  return (
    <div className="w-[48px] h-[6px] rounded-full bg-muted overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full transition-all duration-300 bg-muted-foreground/40"
        style={{ width: `${Math.min(100, Math.max(0, leftPct))}%` }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Window label (shows percent remaining)
// ---------------------------------------------------------------------------

function WindowLabel({ w, label }: { w: RateLimitWindow; label: string }): React.JSX.Element {
  const left = Math.max(0, Math.round(100 - w.usedPercent))
  return (
    <span className="tabular-nums">
      {left}% {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Tooltip helpers
// ---------------------------------------------------------------------------

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) {
    return 'just now'
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) {
    return `${mins}m ago`
  }
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return 'now'
  }
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) {
    return `${totalMins}m`
  }
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

// ---------------------------------------------------------------------------
// Tooltip — progress bar section for a single window
// ---------------------------------------------------------------------------

// Why: the base tooltip component uses `bg-foreground text-background` which
// inverts the color scheme (light bg in dark mode). These rich tooltips use
// `text-background` for primary text and `text-background/50` for secondary
// to stay readable inside the inverted tooltip container.

function TooltipWindowSection({
  w,
  label
}: {
  w: RateLimitWindow | null
  label: string
}): React.JSX.Element | null {
  if (!w) {
    return null
  }
  const leftPct = Math.max(0, Math.round(100 - w.usedPercent))
  const resetIn = w.resetsAt ? formatDuration(w.resetsAt - Date.now()) : null

  return (
    <div className="space-y-1">
      <div className="font-medium text-background">{label}</div>
      <div className="w-full h-[6px] rounded-full bg-background/20 overflow-hidden">
        <div
          className="h-full rounded-full bg-background/50 transition-all duration-300"
          style={{ width: `${Math.min(100, Math.max(0, leftPct))}%` }}
        />
      </div>
      <div className="flex justify-between text-background/60">
        <span>{leftPct}% left</span>
        {resetIn && <span>Resets in {resetIn}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tooltip content
// ---------------------------------------------------------------------------

function ProviderTooltip({ p }: { p: ProviderRateLimits | null }): React.JSX.Element {
  if (!p) {
    return <span className="text-xs text-background/60">No data available</span>
  }

  const name = p.provider === 'claude' ? 'Claude' : 'Codex'

  if (p.status === 'unavailable') {
    return (
      <div className="text-xs w-[200px]">
        <div className="font-medium text-background">{name}</div>
        <div className="text-background/60">{p.error ?? 'CLI not found'}</div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <div className="text-xs w-[200px]">
        <div className="font-medium text-background">{name}</div>
        <div className="text-background/60">{p.error ?? 'Unable to fetch usage'}</div>
      </div>
    )
  }

  const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated'

  return (
    <div className="text-xs w-[200px] space-y-3">
      {/* Header */}
      <div>
        <div className="font-medium text-background text-[13px]">{name}</div>
        <div className="text-background/50">{updatedAgo}</div>
      </div>

      {/* Divider */}
      <div className="border-t border-background/15" />

      {/* Session window */}
      <TooltipWindowSection w={p.session} label="Session" />

      {/* Weekly window */}
      <TooltipWindowSection w={p.weekly} label="Weekly" />

      {/* Stale data warning */}
      {p.error && <div className="text-background/40 italic">Stale — {p.error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider segment
// ---------------------------------------------------------------------------

function ProviderSegment({
  p,
  compact
}: {
  p: ProviderRateLimits | null
  compact: boolean
}): React.JSX.Element {
  const name = p?.provider === 'codex' ? 'Codex' : 'Claude'

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="text-muted-foreground">
        {name}: <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Fetching with no prior data
  if (p.status === 'fetching' && !p.session && !p.weekly) {
    return (
      <span className="text-muted-foreground">
        {name}: <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return <span className="text-muted-foreground/50">{name}: --</span>
  }

  // Error with no data
  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <span className="text-muted-foreground/70">
        {name}: <span className="text-yellow-500">&loz;</span>
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error'
  const isFetching = p.status === 'fetching'

  return (
    <span className={`inline-flex items-center gap-1.5 ${isStale ? 'opacity-60' : ''}`}>
      <span className="font-medium">{name}</span>
      {p.session && !compact && <MiniBar leftPct={Math.max(0, 100 - p.session.usedPercent)} />}
      {p.session && <WindowLabel w={p.session} label="5h" />}
      {p.session && p.weekly && <span className="text-muted-foreground">&middot;</span>}
      {p.weekly && <WindowLabel w={p.weekly} label="wk" />}
      {isFetching && <RefreshCw size={10} className="animate-spin text-muted-foreground" />}
    </span>
  )
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export function StatusBar(): React.JSX.Element {
  const rateLimits = useAppStore((s) => s.rateLimits)
  const refreshRateLimits = useAppStore((s) => s.refreshRateLimits)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Why: we track container width via ResizeObserver to implement responsive
  // breakpoints on the status bar's own width (not the window), so sidebar
  // open/close correctly changes the layout.
  const [containerWidth, setContainerWidth] = useState(900)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const containerRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (resizeObserverRef.current) {
      resizeObserverRef.current.disconnect()
      resizeObserverRef.current = null
    }
    if (node) {
      containerRef.current = node
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setContainerWidth(entry.contentRect.width)
        }
      })
      observer.observe(node)
      resizeObserverRef.current = observer
      setContainerWidth(node.getBoundingClientRect().width)
    }
  }, [])

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return
    }
    setIsRefreshing(true)
    try {
      await refreshRateLimits()
    } finally {
      setIsRefreshing(false)
    }
  }, [isRefreshing, refreshRateLimits])

  const { claude, codex } = rateLimits

  // Why: providers that are unavailable (e.g. Claude for API key users) are
  // hidden entirely to avoid wasting status bar space on a greyed-out label.
  const showClaude = claude && claude.status !== 'unavailable'
  const showCodex = codex && codex.status !== 'unavailable'
  const anyVisible = showClaude || showCodex

  const compact = containerWidth < 900
  const iconOnly = containerWidth < 500

  return (
    <div
      ref={containerRefCallback}
      className="flex items-center h-6 min-h-[24px] px-3 gap-4 border-t border-border bg-[var(--bg-titlebar,var(--card))] text-xs select-none shrink-0"
    >
      {iconOnly ? (
        // Icon-only mode: dots
        <>
          {showClaude && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 cursor-default">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${claude.session || claude.weekly ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
                  />
                  <span className="text-muted-foreground">C</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} collisionPadding={12}>
                <ProviderTooltip p={claude} />
              </TooltipContent>
            </Tooltip>
          )}
          {showCodex && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 cursor-default">
                  <span
                    className={`inline-block w-2 h-2 rounded-full ${codex.session || codex.weekly ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'}`}
                  />
                  <span className="text-muted-foreground">X</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} collisionPadding={12}>
                <ProviderTooltip p={codex} />
              </TooltipContent>
            </Tooltip>
          )}
        </>
      ) : (
        // Full / compact modes
        <>
          {showClaude && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center cursor-default">
                  <ProviderSegment p={claude} compact={compact} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} collisionPadding={12}>
                <ProviderTooltip p={claude} />
              </TooltipContent>
            </Tooltip>
          )}

          {showCodex && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center cursor-default">
                  <ProviderSegment p={codex} compact={compact} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6} collisionPadding={12}>
                <ProviderTooltip p={codex} />
              </TooltipContent>
            </Tooltip>
          )}
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Manual refresh button */}
      {anyVisible && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
              aria-label="Refresh rate limits"
            >
              <RefreshCw size={11} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            Refresh usage data
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
