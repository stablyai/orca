import { describe, expect, it } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../../../shared/tui-agent'
import { resolveInitialNativeChatSessionOptions } from './native-chat-launch-session-options'

const CUSTOM_CODEX_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'
const CUSTOM_GEMINI_ID = 'custom-agent:gemini:22222222-2222-4222-8222-222222222222'
const UNCATALOGED_CUSTOM_ID = 'custom-agent:codex:33333333-3333-4333-8333-333333333333'

function customAgent(id: CustomTuiAgentId, baseAgent: CustomTuiAgent['baseAgent']): CustomTuiAgent {
  return { id, baseAgent, label: 'Custom', args: '', env: {}, syncEnv: false }
}

const settings = {
  experimentalNativeChat: true,
  openAgentTabsInChatByDefault: true,
  nativeChatSessionOptions: {
    codex: {
      model: 'gpt-5.2-codex',
      valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
    }
  }
}

describe('resolveInitialNativeChatSessionOptions', () => {
  it('omits native-chat preferences from terminal-default launches', () => {
    expect(
      resolveInitialNativeChatSessionOptions(
        { ...settings, openAgentTabsInChatByDefault: false },
        { agent: 'codex' }
      )
    ).toBeUndefined()
  })

  it('applies native-chat preferences when the launch resolves to chat', () => {
    expect(resolveInitialNativeChatSessionOptions(settings, { agent: 'codex' })).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })

  it('omits preferences when a draft forces the initial view back to terminal', () => {
    expect(
      resolveInitialNativeChatSessionOptions(settings, {
        agent: 'codex',
        promptDelivery: 'draft',
        launchDraftText: 'one\u2028two'
      })
    ).toBeUndefined()
  })

  it('omits preferences when a remote transcript forces the initial view to terminal', () => {
    const grokSettings = {
      ...settings,
      nativeChatSessionOptions: { grok: { model: 'grok-4.5' } }
    }
    expect(
      resolveInitialNativeChatSessionOptions(grokSettings, {
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: false
      })
    ).toBeUndefined()
  })

  it('opens a live custom agent in chat with the preferences stored under its OWN id', () => {
    // The leak guard: keying these on the base would hand every custom Codex
    // agent the built-in's model, and vice versa.
    expect(
      resolveInitialNativeChatSessionOptions(
        {
          ...settings,
          customTuiAgents: [customAgent(CUSTOM_CODEX_ID, 'codex')],
          nativeChatSessionOptions: {
            ...settings.nativeChatSessionOptions,
            [CUSTOM_CODEX_ID]: {
              model: 'gpt-5.2-codex-custom',
              valuesByModel: { 'gpt-5.2-codex-custom': { effort: 'high' } }
            }
          }
        },
        { agent: CUSTOM_CODEX_ID }
      )
    ).toEqual({ model: 'gpt-5.2-codex-custom', effort: 'high' })
  })

  it("omits preferences the custom agent has none of, rather than borrowing the base agent's", () => {
    expect(
      resolveInitialNativeChatSessionOptions(
        { ...settings, customTuiAgents: [customAgent(CUSTOM_CODEX_ID, 'codex')] },
        { agent: CUSTOM_CODEX_ID }
      )
    ).toBeUndefined()
  })

  it('keeps an uncataloged custom id and an unsupported base out of chat entirely', () => {
    const optionsFor = (
      agent: CustomTuiAgentId,
      customTuiAgents: CustomTuiAgent[]
    ): Record<string, unknown> | undefined =>
      resolveInitialNativeChatSessionOptions(
        {
          ...settings,
          customTuiAgents,
          nativeChatSessionOptions: { [agent]: { model: 'gpt-5.2-codex' } }
        },
        { agent }
      )
    expect(
      optionsFor(UNCATALOGED_CUSTOM_ID, [customAgent(CUSTOM_CODEX_ID, 'codex')])
    ).toBeUndefined()
    expect(optionsFor(CUSTOM_GEMINI_ID, [customAgent(CUSTOM_GEMINI_ID, 'gemini')])).toBeUndefined()
  })
})
