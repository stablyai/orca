import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SUBAGENT_STALE_AFTER_MS,
  claudeRosterHasWorkingSubagent,
  pruneStaleClaudeSubagents,
  upsertWorkingClaudeSubagent,
  type ClaudeSubagentRoster
} from './claude-subagent-roster'

describe('claude subagent roster expiry', () => {
  it('expires a working row after bounded inactivity', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)

    expect(claudeRosterHasWorkingSubagent(roster, 100 + CLAUDE_SUBAGENT_STALE_AFTER_MS)).toBe(true)
    expect(claudeRosterHasWorkingSubagent(roster, 100 + CLAUDE_SUBAGENT_STALE_AFTER_MS + 1)).toBe(
      false
    )
    expect(roster.size).toBe(0)
  })

  it('refreshes the expiry window when a live child event is re-tracked', () => {
    const roster: ClaudeSubagentRoster = new Map()
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 100)
    upsertWorkingClaudeSubagent(roster, 'a1', {}, 200)

    expect(claudeRosterHasWorkingSubagent(roster, 100 + CLAUDE_SUBAGENT_STALE_AFTER_MS + 1)).toBe(
      true
    )
    expect(pruneStaleClaudeSubagents(roster, 200 + CLAUDE_SUBAGENT_STALE_AFTER_MS + 1)).toBe(true)
  })
})
