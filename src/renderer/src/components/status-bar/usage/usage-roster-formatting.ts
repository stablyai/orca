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
