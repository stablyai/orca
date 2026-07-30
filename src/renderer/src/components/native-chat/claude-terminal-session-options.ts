import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { stripScrollbackAnsi } from './native-chat-scrape-fallback'

const EFFORT_ID_BY_LABEL: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra high': 'xhigh',
  xhigh: 'xhigh',
  max: 'max'
}

function normalizedScreenLines(screen: string): string[] {
  return stripScrollbackAnsi(screen)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
}

export function readClaudeSessionOptionsFromTerminalScreen(
  screen: string | null | undefined
): Record<string, SessionOptionValue> | null {
  if (!screen) {
    return null
  }
  const lines = normalizedScreenLines(screen)
  const headerIndex = lines.findIndex((line) =>
    // xterm serialization can remove cursor-positioning cells between the
    // product name and version, producing `Claude Codev2.1.211`.
    /\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i.test(line)
  )
  if (headerIndex < 0) {
    return null
  }
  // Why: only Claude's fixed header rows describe live state; conversation
  // text and old command confirmations elsewhere in the buffer can be stale.
  const header = lines.slice(headerIndex, headerIndex + 3).join(' ')
  const catalog = getAgentSessionOptionCatalog('claude')
  const model = [...(catalog?.models ?? [])]
    .sort((left, right) => right.label.length - left.label.length)
    .find(({ label }) => header.toLowerCase().includes(label.toLowerCase()))
  if (!model) {
    return null
  }
  const result: Record<string, SessionOptionValue> = { model: model.id }
  const effortLabel = header.match(
    /\bwith\s+(low|medium|high|extra high|xhigh|max)\s+effort\b/i
  )?.[1]
  const effort = effortLabel ? EFFORT_ID_BY_LABEL[effortLabel.toLowerCase()] : undefined
  if (effort && model.options.some((option) => option.id === 'effort')) {
    result.effort = effort
  }
  return result
}
