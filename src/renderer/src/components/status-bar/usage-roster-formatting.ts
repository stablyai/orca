import type { RateLimitWindow } from '../../../../shared/rate-limit-types'

// Pure formatting for the consolidated Usage roster, split out so it can be unit
// tested without pulling in React / UI dependencies.

// "plus" -> "Plus", "chatgpt_business" -> "ChatGPT Business". Codex is the only
// provider that reports a plan today; others render just the name.
export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim()
  if (!trimmed) {
    return null
  }
  return trimmed
    .split(/[\s_-]+/)
    .map((word) => {
      const normalized = word.toLowerCase()
      return normalized === 'chatgpt'
        ? 'ChatGPT'
        : normalized.charAt(0).toUpperCase() + normalized.slice(1)
    })
    .join(' ')
}

// Mirrors barColor's 60/80 thresholds so the number matches its bar; neutral
// inherits the foreground color (STYLEGUIDE: color reserved for state).
export function usageTextColorClass(usedPercent: number): string {
  if (usedPercent >= 80) {
    return 'text-red-500'
  }
  if (usedPercent >= 60) {
    return 'text-yellow-500'
  }
  return 'text-foreground'
}

// Why: credits are USD amounts; always render the $ so the balance reads as
// money ("$580"), not a bare number. Whole values drop decimals, fractional
// ones keep a single decimal ("$142.5") so the status-bar chip stays compact.
export function formatCreditAmount(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null
  }
  const rounded = Math.round(value * 10) / 10
  const formatted = Number.isInteger(rounded)
    ? rounded.toLocaleString('en-US')
    : rounded.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `$${formatted}`
}

// "kalan | kullanılan" — remaining first, matching the "remaining | used"
// contract of the Nous Portal subscription payload. Short labels disambiguate
// the two values where there is room (roster rows, tooltip).
export function formatWindowAmounts(window: RateLimitWindow): string | null {
  const remaining = formatCreditAmount(window.remainingAmount)
  const used = formatCreditAmount(window.usedAmount)
  if (remaining === null && used === null) {
    return null
  }
  return `${remaining ? `${remaining} left` : '—'} | ${used ? `${used} used` : '—'}`
}

// Compact form for the status-bar pill: labels dropped, $ retained.
export function formatWindowAmountsCompact(window: RateLimitWindow): string | null {
  const remaining = formatCreditAmount(window.remainingAmount)
  const used = formatCreditAmount(window.usedAmount)
  if (remaining === null && used === null) {
    return null
  }
  return `${remaining ?? '—'} | ${used ?? '—'}`
}
