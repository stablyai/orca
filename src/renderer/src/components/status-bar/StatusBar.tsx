import { RefreshCw } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '../../store'
import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { ProviderIcon, ProviderTooltip } from './tooltip'

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
// Provider segment
// ---------------------------------------------------------------------------

function ProviderSegment({
  p,
  compact
}: {
  p: ProviderRateLimits | null
  compact: boolean
}): React.JSX.Element {
  const provider = p?.provider ?? 'claude'

  // Idle / initial load
  if (!p || p.status === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Fetching with no prior data
  if (p.status === 'fetching' && !p.session && !p.weekly) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ProviderIcon provider={provider} />
        <span className="animate-pulse">&middot;&middot;&middot;</span>
      </span>
    )
  }

  // Unavailable (CLI not installed)
  if (p.status === 'unavailable') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/50">
        <ProviderIcon provider={provider} /> --
      </span>
    )
  }

  // Error with no data
  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground/70">
        <ProviderIcon provider={provider} />
        <span className="text-yellow-500">&loz;</span>
      </span>
    )
  }

  // Has data (ok, fetching with stale data, or error with stale data)
  const isStale = p.status === 'error'
  const isFetching = p.status === 'fetching'

  return (
    <span className={`inline-flex items-center gap-1.5 ${isStale ? 'opacity-60' : ''}`}>
      <ProviderIcon provider={provider} />
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
