import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { AgentIcon } from '@/lib/agent-catalog'
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { translate } from '@/i18n/i18n'

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

export function formatResetCountdown(ms: number): string {
  const duration = formatDuration(ms)
  return duration === 'now' ? 'Resets now' : `Resets in ${duration}`
}

// ---------------------------------------------------------------------------
// Shared icon component
// ---------------------------------------------------------------------------

export function ProviderIcon({ provider }: { provider: string }): React.JSX.Element {
  if (provider === 'codex') {
    return <OpenAIIcon size={13} />
  }
  if (provider === 'gemini') {
    return <GeminiIcon size={13} />
  }
  if (provider === 'opencode-go') {
    return <OpenCodeGoIcon size={13} />
  }
  if (provider === 'kimi') {
    return <AgentIcon agent="kimi" size={13} />
  }
  return <ClaudeIcon size={13} />
}

export function getProviderDisplayName(provider: ProviderRateLimits['provider']): string {
  if (provider === 'claude') {
    return 'Claude'
  }
  if (provider === 'codex') {
    return 'Codex'
  }
  if (provider === 'gemini') {
    return 'Gemini'
  }
  if (provider === 'opencode-go') {
    return 'OpenCode Go'
  }
  if (provider === 'kimi') {
    return 'Kimi'
  }
  return provider
}

function isUsageRateLimitError(message: string | null): boolean {
  return Boolean(message && /\brate[- ]?limits?\b|\brate[- ]?limited\b/i.test(message))
}

const USAGE_AUTH_ERROR_PATTERNS = [
  // Why: "OAuth" can be an upstream route label; only credential/session wording
  // should hide raw details behind the softer usage-refresh copy.
  /\binvalid (?:authentication )?credentials?\b/i,
  /\b(?:no|missing|invalid|expired|stale|unavailable) (?:oauth )?(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) (?:is |are |was |were |could not be |cannot be |can't be )?(?:missing|unavailable|invalid|expired|stale|used|refreshed|loaded|found)\b/i,
  /\bcredentials?[ -]file (?:is |was )?(?:missing|unavailable|invalid|expired|stale)\b/i,
  /\b(?:access token|refresh token|token|credentials?|auth(?:entication)? session|auth cookie) not (?:found|available)\b/i,
  /\b(?:token data|tokens?) (?:is |are )?not available\b/i,
  /\bauth (?:is missing|tokens are missing|does not expose)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bunauthenticated\b/i,
  /\bplease reauthenticate\b/i,
  /\bsign in\b/i,
  /\blogged in to another account\b/i,
  /\bnot logged in\b/i,
  /\blog[ -]?in\b/i,
  /\blog(?:ged)? out\b/i
]

function isUsageAuthError(message: string | null): boolean {
  return Boolean(message && USAGE_AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(message)))
}

export function getProviderUsageStatusLabel(p: ProviderRateLimits): string {
  if (isUsageRateLimitError(p.error)) {
    return translate('auto.components.status.bar.tooltip.7ad719c4bf', 'Limited')
  }
  return translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed')
}

export function getProviderUsageErrorMessage(p: ProviderRateLimits): string {
  const fallback = translate(
    'auto.components.status.bar.tooltip.2c35eca8d4',
    'Unable to fetch usage'
  )
  if (!p.error) {
    return fallback
  }
  if (isUsageRateLimitError(p.error)) {
    return p.error
  }
  if (isUsageAuthError(p.error)) {
    const name = getProviderDisplayName(p.provider)
    return translate(
      'auto.components.status.bar.tooltip.8418ec448d',
      '{{value0}} usage could not be refreshed. Agent sessions may still be signed in.',
      { value0: name }
    )
  }
  return p.error
}

function ErrorMessage({
  message,
  label,
  stale = false,
  inverted = false
}: {
  message: string
  label?: string
  /** When true, prior data is still visible — show a softer "refresh failed" label. */
  stale?: boolean
  inverted?: boolean
}): React.JSX.Element {
  const labelClass = inverted ? 'text-background/80' : 'text-foreground/85'
  const detailClass = inverted ? 'text-background/55' : 'text-muted-foreground'

  return (
    <div className="space-y-0.5">
      <div className={`text-[11px] font-medium ${labelClass}`}>
        {stale
          ? translate(
              'auto.components.status.bar.tooltip.a9a318b7a3',
              'Refresh failed — showing cached data'
            )
          : (label ?? translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed'))}
      </div>
      <div className={detailClass}>{message}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Window section derivation
// ---------------------------------------------------------------------------

export function getWindowSections(
  p: ProviderRateLimits
): { label: string; window: RateLimitWindow | null }[] {
  if (p.buckets?.length) {
    const bucketSections = p.buckets.map((b) => ({ label: b.name, window: b as RateLimitWindow }))
    return [
      ...bucketSections,
      {
        label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
        window: p.weekly
      }
    ]
  }
  const sections: { label: string; window: RateLimitWindow | null }[] = [
    {
      label: translate('auto.components.status.bar.tooltip.94038ad2fa', 'Session'),
      window: p.session
    },
    {
      label: translate('auto.components.status.bar.tooltip.252c096536', 'Weekly'),
      window: p.weekly
    }
  ]
  if (p.monthly !== undefined && p.monthly !== null) {
    sections.push({
      label: translate('auto.components.status.bar.tooltip.7f7f208060', 'Monthly'),
      window: p.monthly
    })
  }
  return sections
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
export function barColor(leftPct: number): string {
  if (leftPct > 40) {
    return 'bg-green-500'
  }
  if (leftPct > 20) {
    return 'bg-yellow-500'
  }
  return 'bg-red-500'
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
    return (
      <span className={`text-xs ${mutedClass}`}>
        {translate('auto.components.status.bar.tooltip.6d6df77f41', 'No data available')}
      </span>
    )
  }

  const name = getProviderDisplayName(p.provider)

  if (p.status === 'unavailable') {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className={mutedClass}>
          {p.error ?? translate('auto.components.status.bar.tooltip.1292d4f2ee', 'Unavailable')}
        </div>
      </div>
    )
  }

  if (p.status === 'error' && !p.session && !p.weekly && !p.monthly) {
    return (
      <div className={`text-xs ${className ?? 'w-full'}`}>
        <div className={`flex items-center gap-1.5 font-medium ${textClass}`}>
          <ProviderIcon provider={p.provider} />
          {name}
        </div>
        <div className="mt-2">
          <ErrorMessage
            label={getProviderUsageStatusLabel(p)}
            message={getProviderUsageErrorMessage(p)}
            inverted={inverted}
          />
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
    const resetLabel = w.resetsAt ? formatResetCountdown(w.resetsAt - Date.now()) : null

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
          <span>
            {leftPct}
            {translate('auto.components.status.bar.tooltip.cedb7b99e3', '% left')}
          </span>
          {resetLabel && <span>{resetLabel}</span>}
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

      {getWindowSections(p).map((s) => (
        <PanelWindowSection key={s.label} w={s.window} label={s.label} />
      ))}

      {p.error ? (
        <ErrorMessage
          message={p.error}
          stale={!!(p.session || p.weekly || p.monthly)}
          inverted={inverted}
        />
      ) : null}
    </div>
  )
}
