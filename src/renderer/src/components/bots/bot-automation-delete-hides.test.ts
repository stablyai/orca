import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity } from '../../../../shared/bots/bot-activity-model'
import type { BotAutomationRow } from '../../../../shared/bots/bot-automation-rows'
import { botNextRun, botAutomationCardRows, botRunningRow } from './bot-automation-card'
import {
  hiddenAutomationCardKeys,
  hiddenAutomationIds,
  pruneAutomationHides,
  withoutHiddenAutomations,
  type BotAutomationHide
} from './bot-automation-delete-hides'
import type { BotReadAuthority } from './bot-read-authority'

const at11: BotReadAuthority = { kind: 'environment', environmentId: 'env', pairingRevision: 11 }
const at22: BotReadAuthority = { kind: 'environment', environmentId: 'env', pairingRevision: 22 }
const hide = (id: string, expiresAt = 1_000): BotAutomationHide => ({
  authority: 'environment:env:11',
  id,
  name: id,
  expiresAt
})

function row(id: string, nextRunAt: number): BotAutomationRow {
  return {
    key: `k-${id}`,
    automation: {
      id,
      name: id,
      enabled: true,
      nextRunAt,
      updatedAt: 1,
      dtstart: 0,
      rrule: 'FREQ=DAILY',
      workspaceId: null
    },
    failing: false
  }
}

const bot: Bot = {
  id: 'b',
  name: 'B',
  hostId: 'local',
  folder: 'b',
  folderWorkspaceId: 'b-workspace',
  agent: 'opencode',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const activity = (...rows: BotAutomationRow[]): BotActivity => ({
  workers: [],
  inProgress: [],
  completed: [],
  automations: rows,
  waits: []
})

describe('automation hides', () => {
  it('hide only under the incarnation that deleted them', () => {
    expect([...hiddenAutomationIds([hide('a')], at11)]).toEqual(['a'])
    // A same-id row listed by a newer pairing is a different record and stays.
    expect(hiddenAutomationIds([hide('a')], at22).size).toBe(0)
    expect(hiddenAutomationIds([hide('a')], null).size).toBe(0)
  })

  it('end when the host stops listing them or the incarnation changes, and come back past their time', () => {
    const hides = [hide('gone'), hide('listed'), hide('late', 500)]
    const listed = new Set(['listed', 'late'])
    const { kept, expired } = pruneAutomationHides(hides, at11, listed, 600)
    expect(kept.map((h) => h.id)).toEqual(['listed'])
    expect(expired.map((h) => h.id)).toEqual(['late'])
    expect(pruneAutomationHides(hides, at22, listed, 0).kept).toEqual([])
    const steady = [hide('listed')]
    expect(pruneAutomationHides(steady, at11, listed, 0).kept).toBe(steady)
  })

  it('drop a deleted automation from the card, its header line and its card keys at once', () => {
    const now = 100
    const raw = activity(row('soon', 200), row('later', 300))
    const hidden = hiddenAutomationIds([hide('soon')], at11)
    const shown = withoutHiddenAutomations(raw, hidden)
    expect(shown.automations.map((r) => r.automation.id)).toEqual(['later'])
    const before = botNextRun(botAutomationCardRows(bot, raw, now))
    const after = botNextRun(botAutomationCardRows(bot, shown, now))
    expect(before?.key).toBe('automation:k-soon')
    expect(after?.key).toBe('automation:k-later')
    expect(botRunningRow(botAutomationCardRows(bot, shown, now))).toBeNull()
    expect([...hiddenAutomationCardKeys(raw, hidden)]).toEqual(['automation:k-soon'])
    // Nothing hidden: the same object, so nothing downstream recomputes.
    expect(withoutHiddenAutomations(raw, hiddenAutomationIds([], at11))).toBe(raw)
  })
})
