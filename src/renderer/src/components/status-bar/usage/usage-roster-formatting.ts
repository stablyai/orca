// Anthropic renamed Max 20x to Ultra and Max 5x to plain Max.
const CLAUDE_PLAN_LABELS: Record<string, string> = { max_20x: 'Ultra', max_5x: 'Max' }

export function formatPlanLabel(planType: string | null | undefined): string | null {
  const trimmed = planType?.trim()
  // Codex reports "unknown" when it cannot tell; that is no plan, not a plan named Unknown.
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null
  }
  const claudeLabel = CLAUDE_PLAN_LABELS[trimmed.toLowerCase()]
  if (claudeLabel) {
    return claudeLabel
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
