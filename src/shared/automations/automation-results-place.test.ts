import { describe, expect, it } from 'vitest'
import type { AutomationBotTarget } from '../automation-bot-target'
import { automationResultsSentence, formatAutomationResultsTo } from './automation-results-place'

const THREAD = {
  source: 'slack',
  externalId: 'T1:C1:1.2',
  place: '#design',
  sessionId: 's1'
} as const
const base: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: 'chat' }
const IN_THREAD: AutomationBotTarget = {
  ...base,
  runsIn: 'chat',
  chat: { sessionId: 's1', homeIfGone: true, toConversation: true },
  originThread: THREAD
}

describe('where a bot automation says its results go', () => {
  it('names the thread a chat answers, with a copy named besides', () => {
    expect(formatAutomationResultsTo(IN_THREAD)).toBe(
      'results to: the Slack thread in #design (a reply in the thread)'
    )
    expect(
      automationResultsSentence({ ...IN_THREAD, resultsTo: { linearIssue: 'ENG-1' } }, 'scheduled')
    ).toBe(
      'Your final message posts as a reply in the Slack thread in #design, and a copy posts as a comment on ENG-1.'
    )
  })

  it('names a channel post as a new top-level post', () => {
    const target: AutomationBotTarget = { ...base, resultsTo: { channel: 'C9', label: '#news' } }
    expect(formatAutomationResultsTo(target)).toBe('results to: #news (a new top-level post)')
  })

  it("names an event's thread, and keeps a run by hand in Orca", () => {
    const events: AutomationBotTarget = { ...base, resultsTo: 'thread' }
    expect(automationResultsSentence(events, 'event')).toBe(
      "Your final message posts as a reply in the event's thread or issue."
    )
    expect(automationResultsSentence(events, 'manual')).toBe(
      'Your final message stays in Orca, in this conversation: nothing posts it anywhere.'
    )
  })

  it('says a result that stays in Orca stays there', () => {
    expect(formatAutomationResultsTo(base)).toBe("results to: the bot's Chat (stays in Orca)")
    expect(
      automationResultsSentence({ ...base, runsIn: 'chat', chat: { sessionId: 's2' } }, 'scheduled')
    ).toBe('Your final message stays in Orca, in this chat.')
  })
})
