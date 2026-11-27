import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../../shared/bot-types'
import { buildBotActivity } from '../../../../../shared/bots/bot-activity-model'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import {
  AUTOMATION_CARD_CAP,
  botAutomationCardRows,
  botAutomationCardView
} from '../../bots/bot-automation-card'
import { makeAutomation, makeAutomationListRow } from '../automations-page-fixtures'
import { botListFilter, filterAutomationListRows } from './automation-list-view'

const bot: Bot = {
  id: 'bot-1',
  name: 'Fixture Bot',
  hostId: 'local',
  folder: 'fixture-bot',
  folderWorkspaceId: 'fixture-bot-home',
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
const home = folderWorkspaceKey(bot.folderWorkspaceId)

function automation(id: string, overrides: Partial<Automation> = {}): Automation {
  return makeAutomation({ id, name: `Fixture ${id}`, workspaceId: home, ...overrides })
}

// The bot's home: seven automations (one paused) and two waits. Elsewhere: another workspace's.
const hostAutomations: Automation[] = [
  ...Array.from({ length: 6 }, (_, index) =>
    automation(`auto-${index}`, { nextRunAt: index + 10 })
  ),
  automation('auto-paused', { enabled: false }),
  automation('wait-1', { once: { by: 50 } }),
  automation('wait-2', { once: {} }),
  automation('other', { workspaceId: 'folder:other-home' }),
  automation('unplaced', { workspaceId: null })
]

describe("a bot's All N automations", () => {
  it('opens a list that shows exactly the N automations it counts', () => {
    // As the host reads Activity: the automations that run in the bot's home.
    const activity = buildBotActivity({
      bot,
      sessions: [],
      links: [],
      workers: [],
      automations: hostAutomations.filter((entry) => entry.workspaceId === home),
      runs: [],
      sessionStatus: () => null
    })
    const card = botAutomationCardRows(bot, activity, 0)
    const view = botAutomationCardView(card)

    // As the Automations page lists them: every host automation except waits.
    const pageRows = hostAutomations
      .filter((entry) => !entry.once)
      .map((entry) => makeAutomationListRow({ automation: entry }))
    const listed = filterAutomationListRows(
      pageRows,
      botListFilter({ workspaceId: home, name: bot.name })
    )

    expect(view.listed).toBe(7)
    expect(view.listedPaused).toBe(1)
    expect(listed.map((row) => row.automation.id).sort()).toEqual(
      [...Array.from({ length: 6 }, (_, index) => `auto-${index}`), 'auto-paused'].sort()
    )
    // Rows the card hides are ones the filtered page lists; waits it cannot list stay on the card.
    const shownKeys = new Set(view.shown.map((row) => row.key))
    const hidden = card.filter((row) => !shownKeys.has(row.key))
    expect(hidden.every((row) => row.kind === 'automation')).toBe(true)
    expect(hidden).toHaveLength(7 - AUTOMATION_CARD_CAP)
    expect(view.shown.filter((row) => row.kind === 'wait')).toHaveLength(2)
  })
})
