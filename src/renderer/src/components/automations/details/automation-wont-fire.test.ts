import { describe, expect, it } from 'vitest'
import {
  EVENT_ONLY_SCHEDULE,
  type AutomationEventTrigger
} from '../../../../../shared/automation-event-triggers'
import type { BotConnectors } from '../../../../../shared/bot-event-sources'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { automationWontFire } from './automation-wont-fire'

const SLACK = { appId: 'A1', teamId: 'T1' }
const BOT_TARGET = {
  botId: 'bot-1',
  runsIn: 'new',
  resultsTo: 'chat'
} as const

const SLACK_MENTIONED: AutomationEventTrigger = {
  id: 's',
  source: 'slack',
  event: 'mentioned'
}
const CI_FAILED: AutomationEventTrigger = {
  id: 'g1',
  source: 'github',
  event: 'ci_failed'
}
const PR_OPENED: AutomationEventTrigger = {
  id: 'g2',
  source: 'github',
  event: 'pr_opened'
}
const WEBHOOK_CALL: AutomationEventTrigger = {
  id: 'w',
  source: 'webhook',
  event: 'call',
  rev: 1
}
const ASSIGNED: AutomationEventTrigger = {
  id: 'l',
  source: 'linear',
  event: 'assigned'
}

function label(
  bot: Omit<BotConnectors, 'name'>,
  on: AutomationEventTrigger[],
  webhooks?: boolean,
  dtstart: number = EVENT_ONLY_SCHEDULE.dtstart
): string | null {
  return (
    automationWontFire(
      { bot: BOT_TARGET, on, dtstart },
      [{ id: 'bot-1', name: 'Ranger', ...bot }],
      webhooks
    )?.label ?? null
  )
}

describe('automationWontFire', () => {
  it("marks a webhook automation only when the host says its cloud doesn't take webhooks", () => {
    expect(label({}, [WEBHOOK_CALL], false)).toBe(
      'Won’t run: Orca Cloud doesn’t support webhooks yet'
    )
    expect(label({}, [WEBHOOK_CALL], false, 0)).toBe(
      'Runs on its schedule only: Orca Cloud doesn’t support webhooks yet'
    )
    expect(label({}, [WEBHOOK_CALL], true)).toBeNull()
    // An older host doesn't say; its webhooks are taken to fire.
    expect(label({}, [WEBHOOK_CALL])).toBeNull()
    // A missing connector is the one to ask for.
    expect(label({}, [WEBHOOK_CALL, SLACK_MENTIONED], false)).toBe(
      'Won’t run: needs the Slack connector'
    )
  })

  it('names each missing connector once, and only the missing ones', () => {
    expect(label({ slack: SLACK }, [SLACK_MENTIONED, CI_FAILED, PR_OPENED, ASSIGNED])).toBe(
      'Won’t run: needs the GitHub or Linear connector'
    )
  })

  it('names Google once for Gmail and Calendar rules while Google is off for the bot', () => {
    const mail: AutomationEventTrigger = { id: 'mail', source: 'gmail', event: 'new_email' }
    const meet: AutomationEventTrigger = {
      id: 'meet',
      source: 'calendar',
      event: 'starting_soon',
      minutesBefore: 10
    }
    expect(label({}, [mail, meet])).toBe('Won’t run: needs the Google connector')
    expect(label({}, [mail, CI_FAILED])).toBe('Won’t run: needs the Google or GitHub connector')
    expect(label({ google: true }, [mail, meet])).toBeNull()
  })
})

describe('automationWontFire signed out of Orca', () => {
  const wontFire = (on: AutomationEventTrigger[], hostId?: ExecutionHostId) =>
    automationWontFire(
      { bot: BOT_TARGET, on, dtstart: EVENT_ONLY_SCHEDULE.dtstart },
      [{ id: 'bot-1', name: 'Ranger', slack: SLACK, hostId }],
      false,
      true
    )

  it('says a Slack or webhook rule is paused by sign-in, not a missing connector or support', () => {
    expect(wontFire([SLACK_MENTIONED])).toEqual(
      expect.objectContaining({ label: 'Paused while signed out of Orca', needsConnector: false })
    )
    expect(wontFire([WEBHOOK_CALL])?.label).toBe('Paused while signed out of Orca')
  })

  it("leaves a paired server's bot to its own host's sign-in", () => {
    expect(wontFire([SLACK_MENTIONED], 'runtime:server')).toBeNull()
  })
})
