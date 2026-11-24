// Each bot's waits still waiting, as bots.list carries them for the sidebar's bot rows.
import { pendingWaits } from '../automation-once'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun } from '../automations/history/automation-run'

/** A wait as a bot row names it: what it waits for, and its deadline if it has one. */
export type BotListWait = { label: string; by?: number }

/** Bot id to its waits, soonest deadline first. Older hosts send none. */
export type BotListWaits = Record<string, BotListWait[]>

type WaitRun = Pick<AutomationRun, 'automationId' | 'status' | 'trigger'>

/** Each automation's runs, read in one go. */
type WaitRunsOf = (automationIds: string[]) => ReadonlyMap<string, readonly WaitRun[]>

function waitRuns(waiting: readonly Automation[], runsOf: WaitRunsOf): WaitRun[] {
  // Unreadable run history must not hide the waits.
  try {
    const runsByAutomation = runsOf(waiting.map((automation) => automation.id))
    return waiting.flatMap((automation) => runsByAutomation.get(automation.id) ?? [])
  } catch {
    return []
  }
}

export function listBotWaits(automations: readonly Automation[], runsOf: WaitRunsOf): BotListWaits {
  const waiting = automations.filter((automation) => automation.once && automation.bot?.botId)
  const runs = waitRuns(waiting, runsOf)
  const byBot: BotListWaits = {}
  for (const automation of pendingWaits(waiting, runs)) {
    const botId = automation.bot?.botId
    if (botId) {
      const by = automation.once?.by
      ;(byBot[botId] ??= []).push({
        label: automation.name,
        ...(by !== undefined ? { by } : {})
      })
    }
  }
  return byBot
}
