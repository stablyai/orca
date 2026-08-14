import type { StatusBarItem } from './ui-chrome-types'

// Why: client schemas derive their accepted value domain from this, so a new
// status-bar item cannot drift out of them.
export const STATUS_BAR_ITEMS = [
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
] as const satisfies readonly StatusBarItem[]

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
