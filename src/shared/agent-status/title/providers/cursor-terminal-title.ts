import type { AgentStatus } from '../agent-title-core'

// cursor-agent 2026.11 (display.showStatusIndicators) titles `<chat> - <emoji> <label>[ (<worktree>)]`.
// Review, loading, cloud and reconnect states are not a running turn, so they carry no status.
// Emoji are escaped because orcad bundles reject non-ASCII source.
const CURSOR_STATUS_TITLE_RE =
  /\s-\s(\u{23F3} Working(?: [.\u{B7}]{3})?|\u{2328}\u{FE0F}? Running shell command|\u{1F9ED} Planning|\u{1F4CB} Queued|\u{2753} Waiting for you|\u{1F510} Waiting for confirmation|\u{2705} Ready)(?: \(.*\))?$/u

const CURSOR_STATUS_BY_EMOJI: Record<string, AgentStatus> = {
  '\u{23F3}': 'working',
  '\u{2328}': 'working',
  '\u{1F9ED}': 'working',
  '\u{1F4CB}': 'working',
  '\u{2753}': 'permission',
  '\u{1F510}': 'permission',
  '\u{2705}': 'idle'
}

export function cursorTitleStatus(title: string): AgentStatus | null {
  const emoji = title
    .trim()
    .match(CURSOR_STATUS_TITLE_RE)?.[1]
    ?.split(/[\u{FE0F} ]/u)[0]
  return emoji ? (CURSOR_STATUS_BY_EMOJI[emoji] ?? null) : null
}
