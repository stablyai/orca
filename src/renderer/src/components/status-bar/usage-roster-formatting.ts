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

// Compact just-now / Xm ago / Xh ago. Shared so tooltip and roster 60s/60m
// thresholds cannot drift.
export function formatRelativeTime(updatedAt: number, now: number): string {
  const diff = Math.max(0, now - updatedAt)
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

export function formatUsageUpdatedLabel(updatedAt: number, now: number): string | null {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return null
  }
  return `Updated ${formatRelativeTime(updatedAt, now)}`
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
