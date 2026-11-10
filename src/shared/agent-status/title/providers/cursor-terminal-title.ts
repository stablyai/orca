import type { AgentStatus } from '../agent-title-core'

// cursor-agent 2026.11 (display.showStatusIndicators) titles `<chat> - <emoji> <label>[ (<worktree>)]`.
// Review, loading, cloud and reconnect states are not a running turn, so they carry no status.
const CURSOR_STATUS_TITLE_RE =
  /\s-\s(⏳ Working(?: [.·]{3})?|⌨️? Running shell command|🧭 Planning|📋 Queued|❓ Waiting for you|🔐 Waiting for confirmation|✅ Ready)(?: \(.*\))?$/u

const CURSOR_STATUS_BY_EMOJI: Record<string, AgentStatus> = {
  '⏳': 'working',
  '⌨': 'working',
  '🧭': 'working',
  '📋': 'working',
  '❓': 'permission',
  '🔐': 'permission',
  '✅': 'idle'
}

export function cursorTitleStatus(title: string): AgentStatus | null {
  const emoji = title
    .trim()
    .match(CURSOR_STATUS_TITLE_RE)?.[1]
    ?.split(/[\uFE0F ]/u)[0]
  return emoji ? (CURSOR_STATUS_BY_EMOJI[emoji] ?? null) : null
}
