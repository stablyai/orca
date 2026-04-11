import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { ClaudeIcon, OpenAIIcon } from './icons'

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatTimeAgo(ts: number): string {
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
// Shared icon component
// ---------------------------------------------------------------------------

export function ProviderIcon({ provider }: { provider: string }): React.JSX.Element {
  if (provider === 'codex') {
    return <OpenAIIcon size={13} />
  }
  return <ClaudeIcon size={13} />
}

function ErrorMessage({
  message,
  inverted = false
}: {
  message: string
  inverted?: boolean
}): React.JSX.Element {
  const labelClass = inverted ? 'text-background/80' : 'text-foreground/85'
  const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground'

  return (
    <div className="space-y-0.5">
      <div className={`text-[11px] font-medium ${labelClass}`}>Usage unavailable</div>
      <div className={detailClass}>{message}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tooltip — progress bar section for a single window
// ---------------------------------------------------------------------------

// Why: the base tooltip component uses `bg-foreground text-background` which
// inverts the color scheme (light bg in dark mode). These rich tooltips use
// `text-background` for primary text and `text-background/50` for secondary
// to stay readable inside the inverted tooltip container.

// Why: color-coded by remaining capacity so users can quickly gauge urgency.
// Green = comfortable (>40% left), yellow = caution (20-40%), red = critical (<20%).
function barColor(leftPct: number): string {
  if (leftPct > 40) {
    return 'bg-green-500'
  }
  if (leftPct > 20) {
    return 'bg-yellow-500'
  }
  return 'bg-red-500'
}

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
          className={`h-full rounded-full ${barColor(leftPct)} transition-all duration-300`}
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

export function ProviderTooltip({ p }: { p: ProviderRateLimits | null }): React.JSX.Element {
  if (!p) {
    return <span className="text-xs text-background/60">No data available</span>
  }

  const name = p.provider === 'claude' ? 'Claude' : 'Codex'

  if (p.status === 'unavailable') {
    return (
      <div className="text-xs w-[200px]">
        <div className="flex items-center gap-1.5 font-medium text-background">
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="text-background/60">{p.error ?? 'CLI not found'}</div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <div className="text-xs w-[200px]">
        <div className="flex items-center gap-1.5 font-medium text-background">
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="text-background/60">{p.error ?? 'Unable to fetch usage'}</div>
      </div>
    )
  }

  const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated'

  return (
    <div className="text-xs w-[200px] space-y-3">
      {/* Header */}
      <div>
        <div className="flex items-center gap-1.5 font-medium text-background text-[13px]">
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="text-background/50">{updatedAgo}</div>
      </div>

      {/* Divider */}
      <div className="border-t border-background/15" />

      {/* Session window */}
      <TooltipWindowSection w={p.session} label="Session" />

      {/* Weekly window */}
      <TooltipWindowSection w={p.weekly} label="Weekly" />

      {/* Stale data warning */}
      {p.error ? <ErrorMessage message={p.error} inverted /> : null}
    </div>
  )
}

export function ProviderPanel({
  p,
  inverted = false,
  className
}: {
  p: ProviderRateLimits | null
  inverted?: boolean
  className?: string
}): React.JSX.Element {
  const textClass = inverted ? 'text-background' : 'text-foreground'
  const mutedClass = inverted ? 'text-background/60' : 'text-muted-foreground'
  const faintClass = inverted ? 'text-background/50' : 'text-muted-foreground/80'
  const dividerClass = inverted ? 'border-background/15' : 'border-border/70'
  const emptyBarClass = inverted ? 'bg-background/20' : 'bg-muted'

  if (!p) {
    return <span className={`text-xs ${mutedClass}`}>No data available</span>
  }

  const name = p.provider === 'claude' ? 'Claude' : 'Codex'

  if (p.status === 'unavailable') {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={mutedClass}>{p.error ?? 'CLI not found'}</div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly) {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="mt-2">
          <ErrorMessage message={p.error ?? 'Unable to fetch usage'} inverted={inverted} />
        </div>
      </div>
    )
  }

  const updatedAgo = p.updatedAt ? `Updated ${formatTimeAgo(p.updatedAt)}` : 'Not yet updated'

  const PanelWindowSection = ({
    w,
    label
  }: {
    w: RateLimitWindow | null
    label: string
  }): React.JSX.Element | null => {
    if (!w) {
      return null
    }
    const leftPct = Math.max(0, Math.round(100 - w.usedPercent))
    const resetIn = w.resetsAt ? formatDuration(w.resetsAt - Date.now()) : null

    return (
      <div className="space-y-1">
        <div className={`font-medium ${textClass}`}>{label}</div>
        <div className={`h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`}>
          <div
            className={`h-full rounded-full ${barColor(leftPct)} transition-all duration-300`}
            style={{ width: `${Math.min(100, Math.max(0, leftPct))}%` }}
          />
        </div>
        <div className={`flex justify-between ${mutedClass}`}>
          <span>{leftPct}% left</span>
          {resetIn && <span>Resets in {resetIn}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className={`${className ?? 'w-full'} space-y-3 text-xs`}>
      <div>
        <div className={`flex items-center gap-1.5 text-[13px] font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={faintClass}>{updatedAgo}</div>
      </div>

      <div className={`border-t ${dividerClass}`} />

      <PanelWindowSection w={p.session} label="Session" />
      <PanelWindowSection w={p.weekly} label="Weekly" />

      {p.error ? <ErrorMessage message={p.error} inverted={inverted} /> : null}
    </div>
  )
}
