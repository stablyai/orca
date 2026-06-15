export type ModelDisplay = { name: string; description: string }

type FamilyKey = 'opus' | 'sonnet' | 'haiku' | 'fable'

const FAMILY_DESCRIPTIONS: Record<FamilyKey, string> = {
  opus: 'Most capable for complex tasks',
  sonnet: 'Efficient for routine tasks',
  haiku: 'Fastest for quick answers',
  fable: 'Most capable for your hardest and longest-running tasks'
}

function toTitleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

export function describeModel(id: string): ModelDisplay {
  // Why: anchored to the suffix — only a trailing [1m] means 1M context.
  const has1m = id.endsWith('[1m]')
  // Remove [1m] suffix
  let stripped = id.replace(/\[1m\]$/, '')
  // Remove leading "claude-" prefix
  stripped = stripped.replace(/^claude-/, '')
  // Remove trailing date suffix like -20251001
  stripped = stripped.replace(/-\d{8}$/, '')

  // Detect family
  const familyMatch = stripped.match(/^(opus|sonnet|haiku|fable)/)
  const family = familyMatch ? (familyMatch[1] as FamilyKey) : null

  // Build name: split on "-", map digits-between-digits dashes to dots
  // e.g. "opus-4-8" -> "Opus 4.8", "haiku-4-5" -> "Haiku 4.5", "fable-5" -> "Fable 5"
  // Strategy: replace dashes between digit groups with dots, then split on dash, title-case each word
  const normalized = stripped.replace(/(\d)-(\d)/g, '$1.$2')
  const parts = normalized.split('-')
  const name = parts.map(toTitleCase).join(' ')

  // Build description
  let description = family ? FAMILY_DESCRIPTIONS[family] : id
  if (has1m) {
    description += ' · 1M context'
  }

  return { name, description }
}
