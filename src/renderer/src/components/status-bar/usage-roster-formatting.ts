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

// Relative "Updated …" copy for inactive roster rows; matches tooltip thresholds.
export function formatUsageUpdatedLabel(updatedAt: number, now: number): string | null {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return null
  }
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000) {
    return 'Updated just now'
  }
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) {
    return `Updated ${mins}m ago`
  }
  const hours = Math.floor(mins / 60)
  return `Updated ${hours}h ago`
}

// Match usage-bar 60/80 thresholds while keeping low consumption neutral.
export function usageTextColorClass(usedPercent: number): string {
  if (usedPercent >= 80) {
    return 'text-red-500'
  }
  if (usedPercent >= 60) {
    return 'text-yellow-500'
  }
  return 'text-foreground'
}
