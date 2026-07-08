import type { AiVaultSession } from '../../../../shared/ai-vault-types'

// Which lens the AI Vault panel shows: the session list or the prompt timeline.
export type AiVaultViewMode = 'sessions' | 'prompts'

// One typed prompt in the "My prompts" timeline, kept with its owning session so
// a click can resume that conversation.
export type AiVaultPromptItem = {
  text: string
  timestamp: string | null
  effectiveMs: number
  session: AiVaultSession
}

export type AiVaultPromptDateGroupKind = 'today' | 'yesterday' | 'older'

export type AiVaultPromptDateGroup = {
  key: string
  kind: AiVaultPromptDateGroupKind
  // Start-of-day for the group; the renderer localizes 'older' groups from this.
  dateMs: number
  items: AiVaultPromptItem[]
}

// Rendered-row ceiling: the timeline is not virtualized, so cap items to keep a
// heavy history from mounting tens of thousands of buttons. Older prompts stay
// reachable via search; the UI surfaces a "showing most recent N" note.
export const DEFAULT_TIMELINE_MAX_ITEMS = 500

// Flatten the user's prompts across the given (already scope-filtered) sessions
// into a query-filtered, newest-first, date-grouped timeline. `total` is the
// full match count before the render cap so the UI can report truncation.
export function buildPromptTimeline(
  sessions: readonly AiVaultSession[],
  query: string,
  nowMs: number,
  maxItems: number = DEFAULT_TIMELINE_MAX_ITEMS
): { groups: AiVaultPromptDateGroup[]; total: number } {
  const needle = query.trim().toLowerCase()
  const items: AiVaultPromptItem[] = []
  for (const session of sessions) {
    for (const prompt of session.userPrompts ?? []) {
      if (needle && !prompt.text.toLowerCase().includes(needle)) {
        continue
      }
      items.push({
        text: prompt.text,
        timestamp: prompt.timestamp,
        effectiveMs: promptEffectiveMs(prompt.timestamp, session),
        session
      })
    }
  }

  items.sort((left, right) => right.effectiveMs - left.effectiveMs)
  const total = items.length
  const capped = maxItems > 0 && total > maxItems ? items.slice(0, maxItems) : items
  return { groups: groupPromptItemsByDate(capped, nowMs), total }
}

export function groupPromptItemsByDate(
  items: readonly AiVaultPromptItem[],
  nowMs: number
): AiVaultPromptDateGroup[] {
  const todayStart = startOfDay(nowMs)
  // Yesterday's real local midnight, not a fixed 24h back, so a DST fall-back day
  // (25h) still classifies yesterday's prompts as 'yesterday'.
  const yesterdayStart = startOfDay(todayStart - 1)
  const groups: AiVaultPromptDateGroup[] = []
  let current: AiVaultPromptDateGroup | null = null

  for (const item of items) {
    const dayStart = startOfDay(item.effectiveMs)
    if (!current || current.dateMs !== dayStart) {
      current = {
        key: String(dayStart),
        kind: dayStart >= todayStart ? 'today' : dayStart >= yesterdayStart ? 'yesterday' : 'older',
        dateMs: dayStart,
        items: []
      }
      groups.push(current)
    }
    current.items.push(item)
  }

  return groups
}

function promptEffectiveMs(timestamp: string | null, session: AiVaultSession): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN
  if (Number.isFinite(parsed)) {
    return parsed
  }
  const fallback = Date.parse(session.updatedAt ?? session.modifiedAt)
  return Number.isFinite(fallback) ? fallback : 0
}

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
