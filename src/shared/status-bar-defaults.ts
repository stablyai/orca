import type { StatusBarItem } from './ui-chrome-types'

// Kept as its own list rather than derived from STATUS_BAR_ITEMS: an item may
// exist and ship off by default, so "known items" and "on by default" are
// separate facts.
export const DEFAULT_STATUS_BAR_ITEMS: StatusBarItem[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'ssh',
  'resource-usage',
  'ports',
  'line-blame'
]
