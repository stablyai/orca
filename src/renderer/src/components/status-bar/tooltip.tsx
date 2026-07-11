import type { ProviderRateLimits, RateLimitWindow } from '../../../../shared/rate-limit-types'
import { AgentIcon } from '@/lib/agent-catalog'
import { ClaudeIcon, GeminiIcon, MiniMaxIcon, OpenAIIcon, OpenCodeGoIcon } from './icons'
import { translate } from '@/i18n/i18n'
import {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

export {
  getProviderDisplayName,
  getProviderUsageErrorMessage,
  getProviderUsageStatusLabel
} from './usage-error-copy'

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

export function formatResetCreditExpiry(
  expiresAt: number | null | undefined,
  count: number
): string | null {
  if (!expiresAt) {
    return null
  }
  const duration = formatDuration(expiresAt - Date.now())
  if (duration === 'now') {
    return count > 1
      ? translate('auto.components.status.bar.tooltip.7ec6e030a0', 'Next expires now')
      : translate('auto.components.status.bar.tooltip.d1e442a9e5', 'Expires now')
  }
  return count > 1
    ? translate('auto.components.status.bar.tooltip.6cf9eaed10', 'Next expires in {{value0}}', {
        value0: duration
      })
    : translate('auto.components.status.bar.tooltip.20ad66aed1', 'Expires in {{value0}}', {
        value0: duration
      })
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
  if (provider === 'antigravity') {
    return <AgentIcon agent="antigravity" size={13} />
  }
  if (provider === 'minimax') {
    return <MiniMaxIcon size={13} />
  }
  if (provider === 'grok') {
    return <AgentIcon agent="grok" size={13} />
  }
  return <ClaudeIcon size={13} />
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
  const genericRefreshLabel = translate(
    'auto.components.status.bar.tooltip.e740f92596',
    'Refresh failed'
  )
  const staleRefreshLabel = translate(
    'auto.components.status.bar.tooltip.a9a318b7a3',
    'Refresh failed — showing cached data'
  )
  const resolvedLabel =
    stale && (!label || label === genericRefreshLabel)
      ? staleRefreshLabel
      : (label ?? genericRefreshLabel)

  return (
    <div className="space-y-0.5">
      <div className={`text-[11px] font-medium ${labelClass}`}>{resolvedLabel}</div>
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
  if (p.fableWeekly !== undefined && p.fableWeekly !== null) {
    sections.push({
      label: translate('auto.components.status.bar.tooltip.a79c64f87e', 'Fable'),
      window: p.fableWeekly
    })
  }
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

// Why: single clamp for bar width + label so status bar and tooltip never diverge.
export function clampUsedPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, Math.round(usedPercent)))
}

// Why: color-coded by consumption so users can quickly gauge urgency.
// Matches common harness usage meters (Claude/Codex): bars fill with % used.
// Green = comfortable (<60% used), yellow = caution (60-80%), red = critical (≥80%).
export function barColor(usedPct: number): string {
  if (usedPct < 60) {
    return 'bg-green-500'
  }
  if (usedPct < 80) {
    return 'bg-yellow-500'
  }
  return 'bg-red-500'
}

export function ProviderPanel({
  p,
  inverted = false,
  className,
  showResetCredits = true
}: {
  p: ProviderRateLimits | null
  inverted?: boolean
  className?: string
  showResetCredits?: boolean
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

  if (p.status === 'error' && !p.session && !p.weekly && !p.fableWeekly && !p.monthly) {
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
  const resetCreditCount =
    showResetCredits && p.provider === 'codex'
      ? (p.rateLimitResetCredits?.availableCount ?? null)
      : null
  const resetCreditExpiry =
    resetCreditCount != null
      ? formatResetCreditExpiry(p.rateLimitResetCredits?.nextExpiresAt, resetCreditCount)
      : null

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
    // Why: show % used (consumption), not remaining — matches Claude/Codex
    // harness meters and avoids the "full green bar = exhausted" misread (#7551).
    const usedPct = clampUsedPercent(w.usedPercent)
    const resetLabel = w.resetsAt ? formatResetCountdown(w.resetsAt - Date.now()) : null

    return (
      <div className="space-y-1">
        <div className={`font-medium ${textClass}`}>{label}</div>
        <div className={`h-[6px] w-full overflow-hidden rounded-full ${emptyBarClass}`}>
          <div
            className={`h-full rounded-full ${barColor(usedPct)} transition-all duration-300`}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <div className={`flex justify-between ${mutedClass}`}>
          <span>
            {usedPct}
            {translate('auto.components.status.bar.tooltip.cedb7b99e3', '% used')}
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
        {resetCreditCount !== null && resetCreditCount !== undefined ? (
          <div className={mutedClass}>
            {resetCreditCount === 1
              ? translate(
                  'auto.components.status.bar.tooltip.45198c7d95',
                  '1 rate-limit reset available'
                )
              : translate(
                  'auto.components.status.bar.tooltip.bce421cba3',
                  '{{value0}} rate-limit resets available',
                  { value0: resetCreditCount }
                )}
          </div>
        ) : null}
        {resetCreditExpiry ? <div className={faintClass}>{resetCreditExpiry}</div> : null}
      </div>

      <div className={`border-t ${dividerClass}`} />

      {getWindowSections(p).map((s) => (
        <PanelWindowSection key={s.label} w={s.window} label={s.label} />
      ))}

      {p.error ? (
        <ErrorMessage
          message={p.error}
          stale={!!(p.session || p.weekly || p.fableWeekly || p.monthly)}
          inverted={inverted}
        />
      ) : null}
    </div>
  )
}
