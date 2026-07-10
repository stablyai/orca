import type { StateCreator } from 'zustand'
import type {
  AgentAutoResumeEntry,
  AgentAutoResumeSnapshot
} from '../../../../shared/agent-auto-resume-types'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../types'

// Keys as constants (not inline literals) so the localization catalog verifier
// — which only statically checks literal keys — treats the English fallbacks as
// authoritative, matching the settings-copy pattern.
const RATE_LIMITED_WAITING_KEY = 'auto.lib.auto-resume.rate-limited-waiting'
const RATE_LIMITED_RESUMES_KEY = 'auto.lib.auto-resume.rate-limited-resumes'

// Why: the main-process AgentAutoResumeService pushes its full tracked-entry
// list on every state change; the renderer just mirrors it and derives the
// card/status-bar surfaces from it.
export type AutoResumeSlice = {
  autoResumeEnabled: boolean
  autoResumeEntries: AgentAutoResumeEntry[]
  setAutoResumeSnapshot: (snapshot: AgentAutoResumeSnapshot) => void
}

export const createAutoResumeSlice: StateCreator<AppState, [], [], AutoResumeSlice> = (set) => ({
  autoResumeEnabled: false,
  autoResumeEntries: [],
  setAutoResumeSnapshot: (snapshot) =>
    set({ autoResumeEnabled: snapshot.enabled, autoResumeEntries: snapshot.entries })
})

export type WorktreeRateLimitStatus = {
  hasRateLimited: boolean
  /** Soonest planned resume for the worktree (ms epoch), or null if unknown. */
  resumesAt: number | null
}

const NO_RATE_LIMIT: WorktreeRateLimitStatus = { hasRateLimited: false, resumesAt: null }

/** Rate-limit summary for one worktree: whether any tracked agent in it is
 *  paused, and the soonest planned resume time to display. */
export function selectWorktreeRateLimitStatus(
  state: Pick<AutoResumeSlice, 'autoResumeEntries'>,
  worktreeId: string
): WorktreeRateLimitStatus {
  let hasRateLimited = false
  let resumesAt: number | null = null
  for (const entry of state.autoResumeEntries ?? []) {
    if (entry.worktreeId !== worktreeId) {
      continue
    }
    hasRateLimited = true
    if (
      typeof entry.resumesAt === 'number' &&
      (resumesAt === null || entry.resumesAt < resumesAt)
    ) {
      resumesAt = entry.resumesAt
    }
  }
  return hasRateLimited ? { hasRateLimited, resumesAt } : NO_RATE_LIMIT
}

export function selectHasRateLimitedForWorktree(
  state: Pick<AutoResumeSlice, 'autoResumeEntries'>,
  worktreeId: string
): boolean {
  return (state.autoResumeEntries ?? []).some((entry) => entry.worktreeId === worktreeId)
}

/** "Rate-limited · resumes 3:50 PM", or "· waiting for reset" when the reset
 *  time is unknown (e.g. an unparsed banner or the wait-for-reset menu). */
export function formatRateLimitedLabel(resumesAt: number | null): string {
  if (typeof resumesAt !== 'number' || !Number.isFinite(resumesAt)) {
    return translate(RATE_LIMITED_WAITING_KEY, 'Rate-limited · waiting for reset')
  }
  try {
    const time = new Date(resumesAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return translate(RATE_LIMITED_RESUMES_KEY, 'Rate-limited · resumes {{time}}', { time })
  } catch {
    return translate(RATE_LIMITED_WAITING_KEY, 'Rate-limited · waiting for reset')
  }
}
