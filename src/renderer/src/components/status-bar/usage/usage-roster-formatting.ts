export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim()
  // Codex reports "unknown" when it cannot tell; that is no plan, not a plan named Unknown.
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
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
