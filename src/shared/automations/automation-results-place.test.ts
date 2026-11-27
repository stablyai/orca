import { describe, expect, it } from 'vitest'
import type { AutomationBotTarget } from '../automation-bot-target'
import { automationResultsSentence, formatAutomationResultsTo } from './automation-results-place'

const THREAD = {
  source: 'slack',
  externalId: 'T1:C1:1700000000.000100',
  place: '#design',
  sessionId: 'thread-chat'
} as const
const base: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: 'chat' }

describe('where a bot automation says its results go', () => {
  it('names a channel post as a new top-level post', () => {
    const target: AutomationBotTarget = {
      ...base,
      resultsTo: { channel: 'C9', ref: 'slack:T1:C9', label: '#news' }
    }
    expect(formatAutomationResultsTo(target)).toBe('results to: #news (a new top-level post)')
    expect(automationResultsSentence(target)).toBe(
      'Your final message posts as a new top-level post in #news.'
    )
  })

  it('names the thread a chat answers, with a copy named besides', () => {
    const target: AutomationBotTarget = {
      ...base,
      runsIn: 'chat',
      chat: { sessionId: 's1', homeIfGone: true, toConversation: true },
      originThread: THREAD
    }
    expect(formatAutomationResultsTo(target)).toBe(
      'results to: the Slack thread in #design (a reply in the thread)'
    )
    expect(automationResultsSentence({ ...target, resultsTo: { linearIssue: 'ENG-1' } })).toBe(
      'Your final message posts as a reply in the Slack thread in #design, and a copy posts as a comment on ENG-1.'
    )
  })

  it('names a thread whose place Orca never learned', () => {
    expect(
      automationResultsSentence({
        ...base,
        resultsTo: 'thread',
        originThread: { ...THREAD, place: undefined }
      })
    ).toBe('Your final message posts as a reply in the Slack thread it was made in.')
    expect(automationResultsSentence({ ...base, resultsTo: 'thread' })).toBe(
      "Your final message posts as a reply in the event's thread."
    )
  })

  it('says a result that stays in Orca stays there', () => {
    expect(formatAutomationResultsTo(base)).toBe("results to: the bot's Chat (stays in Orca)")
    expect(automationResultsSentence({ ...base, runsIn: 'chat', chat: { sessionId: 's2' } })).toBe(
      'Your final message stays in Orca, in this chat.'
    )
    expect(formatAutomationResultsTo({ ...base, resultsTo: 'none' })).toBe(
      "results to: nowhere (it stays in the run's conversation in Orca)"
    )
  })
})
