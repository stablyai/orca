import { describe, expect, it } from 'vitest'
import type { AutomationBotTarget } from '../automation-bot-target'
import { botAutomationSetup, sameBotAgentSetup } from './bot-agent-setup'

const bot = { agent: 'claude' as const, launch: { model: 'opus' } }
const own = {
  agent: 'codex' as const,
  launch: { model: 'gpt-6.1-terra', options: { effort: 'high' } }
}

describe('botAutomationSetup', () => {
  it('runs a new conversation on its own setup', () => {
    expect(botAutomationSetup({ runsIn: 'new', agentSetup: own }, bot)).toEqual({
      ...own,
      own: true
    })
  })

  it("runs in a chat, or without a setup, on the bot's", () => {
    const bots = { agent: 'claude', launch: { model: 'opus' }, own: false }
    expect(botAutomationSetup({ runsIn: 'chat', agentSetup: own }, bot)).toEqual(bots)
    expect(botAutomationSetup({ runsIn: 'new' }, bot)).toEqual(bots)
  })

  it("falls back to the bot's for a stored setup on an agent bots can't run on", () => {
    // As an older build's store hands it over: unchecked JSON.
    const stored: AutomationBotTarget = JSON.parse(
      '{"botId":"b","runsIn":"new","resultsTo":"chat","agentSetup":{"agent":"opencode2"}}'
    )
    expect(botAutomationSetup(stored, bot).agent).toBe('claude')
  })
})

describe('sameBotAgentSetup', () => {
  it('tells setups apart by agent, model and option, in any key order', () => {
    expect(sameBotAgentSetup(own, { ...own })).toBe(true)
    expect(sameBotAgentSetup(own, undefined)).toBe(false)
    expect(sameBotAgentSetup(own, { ...own, launch: { model: 'gpt-6.1-terra' } })).toBe(false)
    expect(sameBotAgentSetup(own, { ...own, agent: 'claude' })).toBe(false)
  })
})
