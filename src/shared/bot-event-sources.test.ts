import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from './automation-event-triggers'
import {
  automationUnheardSources,
  botEventSources,
  botEventTriggerRefusal,
  unheardEventTriggers,
  wontFireNote
} from './bot-event-sources'

const SLACK = { appId: 'A1', teamId: 'T1' }
const LINEAR = { workspaceId: 'w1', workspaceName: 'Acme' }
const MENTIONED = { source: 'slack', event: 'mentioned' } as const
const CI_FAILED = { source: 'github', event: 'ci_failed' } as const

describe('bot event sources', () => {
  it("hears only the sources the bot's connectors cover", () => {
    expect(
      botEventSources({
        name: 'Ranger',
        slack: SLACK,
        github: null,
        linear: LINEAR
      })
    ).toEqual(['slack', 'linear'])
    // An older host's bot carries only the connectors that host has.
    expect(botEventSources({ name: 'Ranger', slack: SLACK })).toEqual(['slack'])
  })

  it('keeps the rules from sources the bot has no connector for', () => {
    expect(unheardEventTriggers({ name: 'Ranger', slack: SLACK }, [MENTIONED, CI_FAILED])).toEqual([
      CI_FAILED
    ])
  })

  it('refuses with the missing connector and what the bot can start on instead', () => {
    expect(botEventTriggerRefusal({ name: 'Ranger', slack: SLACK }, [MENTIONED])).toBeNull()
    expect(
      botEventTriggerRefusal({ name: 'Ranger', slack: SLACK, linear: LINEAR }, [CI_FAILED])
    ).toBe(
      'Ranger has no GitHub connector, so github.ci_failed would never start it. It can start on Slack and Linear events or on a schedule; `orca automations trigger-options --bot "Ranger"` lists them. Its owner can add a connector in the bot\'s settings.'
    )
    expect(botEventTriggerRefusal({ name: 'Ranger' }, [MENTIONED, CI_FAILED])).toContain(
      'has no Slack or GitHub connector, so slack.mentioned, github.ci_failed would never start it. It has no connectors, so it can start only on a schedule.'
    )
  })

  it("notes a saved rule that won't fire", () => {
    expect(wontFireNote({ name: 'Ranger', github: {} }, [CI_FAILED])).toBeNull()
    expect(wontFireNote({ name: 'Ranger', github: {} }, [MENTIONED, CI_FAILED])).toBe(
      "won't fire: Ranger has no Slack connector (slack.mentioned)"
    )
  })

  it('hears a webhook whenever the cloud takes them, with no connector', () => {
    const CALL = { source: 'webhook', event: 'call' } as const
    expect(botEventSources({ name: 'Ranger', webhooks: true })).toEqual(['webhook'])
    expect(botEventTriggerRefusal({ name: 'Ranger', webhooks: true }, [CALL])).toBeNull()
    expect(botEventTriggerRefusal({ name: 'Ranger', webhooks: false }, [CALL])).toBe(
      "Orca Cloud doesn't support webhooks yet, so webhook.call would never start Ranger."
    )
    // An older host doesn't say, so a listing claims nothing.
    expect(wontFireNote({ name: 'Ranger' }, [CALL])).toBeNull()
    expect(wontFireNote({ name: 'Ranger', webhooks: false }, [MENTIONED, CALL])).toBe(
      "won't fire: Ranger has no Slack connector (slack.mentioned); Orca Cloud doesn't support webhooks yet (webhook.call)"
    )
  })
})

describe('a host signed out of Orca', () => {
  const WEBHOOK = { source: 'webhook', event: 'call' } as const
  const signedOut = { name: 'Ranger', slack: SLACK, webhooks: false, cloudSignedOut: true }

  it('refuses a Slack event rule before saving, saying why and how the owner signs in', () => {
    expect(botEventTriggerRefusal(signedOut, [MENTIONED])).toBe(
      "This computer is signed out of Orca, and Slack events reach Ranger through Orca Cloud, so nothing was saved. Run `orca bot connectors --offer slack` to show your owner a Sign in line in this chat, then save it again once they say they're signed in."
    )
  })

  it('refuses a webhook as signed out, not as unsupported', () => {
    const refusal = botEventTriggerRefusal(signedOut, [WEBHOOK])
    expect(refusal).toContain('webhooks reach Ranger through Orca Cloud')
    expect(refusal).toContain('--offer webhook')
    expect(refusal).not.toContain("doesn't support")
  })

  it('notes a saved rule as paused by sign-in', () => {
    expect(wontFireNote(signedOut, [MENTIONED])).toBe(
      "won't fire while signed out of Orca (slack.mentioned)"
    )
  })
})

describe('automationUnheardSources', () => {
  const bot = { id: 'b1', name: 'Atlas', slack: null, github: null, linear: null }
  const slackRule = { id: 'r1', source: 'slack', event: 'mentioned' } as const

  it('names the sources the bot has no connector for, and whether a schedule still runs it', () => {
    expect(
      automationUnheardSources(
        { bot: { botId: 'b1' }, on: [slackRule], dtstart: EVENT_ONLY_SCHEDULE.dtstart },
        [bot]
      )
    ).toEqual({ bot, sources: ['slack'], scheduled: false })
    expect(
      automationUnheardSources({ bot: { botId: 'b1' }, on: [slackRule], dtstart: 0 }, [bot])
        ?.scheduled
    ).toBe(true)
  })

  it('says nothing for an unlisted bot or one that hears every source', () => {
    expect(
      automationUnheardSources({ bot: { botId: 'gone' }, on: [slackRule], dtstart: 0 }, [bot])
    ).toBeNull()
    expect(automationUnheardSources({ bot: { botId: 'b1' }, on: [], dtstart: 0 }, [bot])).toBeNull()
  })
})

describe('Google rules', () => {
  const NEW_EMAIL = { source: 'gmail', event: 'new_email' } as const
  it('start a bot only once its owner turns Google on, and say how', () => {
    expect(botEventSources({ name: 'Ada', google: true })).toEqual(['gmail', 'calendar'])
    expect(botEventTriggerRefusal({ name: 'Ada', google: true }, [NEW_EMAIL])).toBeNull()
    expect(botEventTriggerRefusal({ name: 'Ada' }, [NEW_EMAIL])).toBe(
      'Google is off for Ada; its owner can turn it on with `orca google bot "Ada" --on`. Until then gmail.new_email would never start it.'
    )
    expect(wontFireNote({ name: 'Ada' }, [NEW_EMAIL])).toBe(
      "won't fire: Google is off for Ada (gmail.new_email)"
    )
  })
})
