import { describe, expect, it } from 'vitest'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun } from '../automations/history/automation-run'
import { listBotWaits } from './bot-list-waits'

function automation(
  id: string,
  fields: Partial<Pick<Automation, 'name' | 'once'>> & { bot?: { botId: string } }
): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listBotWaits reads only id, name, once and bot.
  return { id, name: id, ...fields } as Automation
}

describe('listBotWaits', () => {
  it("lists each bot's waits still waiting, soonest deadline first", () => {
    const automations = [
      automation('no-deadline', { name: 'CI', once: {}, bot: { botId: 'b1' } }),
      automation('later', {
        name: 'Review',
        once: { by: 2000 },
        bot: { botId: 'b1' }
      }),
      automation('sooner', {
        name: "Nora's reply",
        once: { by: 1000 },
        bot: { botId: 'b1' }
      }),
      automation('ran', {
        name: 'Gone',
        once: { by: 500 },
        bot: { botId: 'b1' }
      }),
      automation('other-bot', {
        name: 'Deploy',
        once: { by: 3000 },
        bot: { botId: 'b2' }
      }),
      automation('recurring', { name: 'Daily', bot: { botId: 'b1' } }),
      automation('no-bot', { name: 'Mine', once: { by: 100 } })
    ]
    const runs: Pick<AutomationRun, 'automationId' | 'status' | 'trigger'>[] = [
      { automationId: 'ran', status: 'dispatched', trigger: 'scheduled' }
    ]

    expect(listBotWaits(automations, () => Map.groupBy(runs, (run) => run.automationId))).toEqual({
      b1: [{ label: "Nora's reply", by: 1000 }, { label: 'Review', by: 2000 }, { label: 'CI' }],
      b2: [{ label: 'Deploy', by: 3000 }]
    })
  })
})
