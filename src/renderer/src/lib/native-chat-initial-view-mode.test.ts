import { describe, it, expect } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../../shared/tui-agent'
import {
  decideInitialAgentTabViewMode,
  initialAgentTabViewModeProps
} from './native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from './native-chat-transcript-readability'

const CUSTOM_CLAUDE_ID = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'
const CUSTOM_GEMINI_ID = 'custom-agent:gemini:22222222-2222-4222-8222-222222222222'
const UNCATALOGED_CUSTOM_ID = 'custom-agent:claude:33333333-3333-4333-8333-333333333333'

function customAgent(id: CustomTuiAgentId, baseAgent: CustomTuiAgent['baseAgent']): CustomTuiAgent {
  return { id, baseAgent, label: 'Custom', args: '', env: {}, syncEnv: false }
}

describe('decideInitialAgentTabViewMode', () => {
  it("returns 'chat' when native chat and the opt-in default setting are on", () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'codex'
      })
    ).toBe('chat')
  })

  it('returns undefined when native chat is disabled', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: true,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('returns undefined when the default-chat setting is off', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: false,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it('returns undefined when the setting is missing (legacy settings)', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: undefined,
        agent: 'codex'
      })
    ).toBeUndefined()
  })

  it.each(['gemini', 'opencode'] as const)(
    'keeps unsupported agent %s in terminal view',
    (agent) => {
      expect(
        decideInitialAgentTabViewMode({
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true,
          agent
        })
      ).toBeUndefined()
    }
  )

  it.each([
    ['local', null],
    ['runtime-owned', 'runtime-ssh-env-1']
  ] as const)('opens %s Grok in chat when configured', (_host, connectionId) => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    ).toBe('chat')
  })

  it('keeps Model-A SSH omp in the terminal view but opens it locally', () => {
    const forConnection = (connectionId: string | null): Tab['viewMode'] =>
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'omp',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(connectionId)
      })
    expect(forConnection('ssh-target-1')).toBeUndefined()
    expect(forConnection(null)).toBe('chat')
  })

  it('keeps Model-A SSH Grok in the terminal view', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'grok',
        nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable('ssh-target-1')
      })
    ).toBeUndefined()
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        },
        { agent: 'grok', nativeChatTranscriptIsLocalReadable: false }
      )
    ).toEqual({})
  })

  it('opens a mirrorable draft launch in chat', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'claude',
        promptDelivery: 'draft',
        launchDraftText: 'https://github.com/o/r/issues/12'
      })
    ).toBe('chat')
  })

  it.each([
    ['multi-line', 'Reproduce first\n\nhttps://github.com/o/r/issues/12'],
    ['trailing-newline', 'https://github.com/o/r/issues/12\n']
  ])('opens a %s draft in chat with its mirrored composer text', (_label, launchDraftText) => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'claude',
        promptDelivery: 'draft',
        launchDraftText
      })
    ).toBe('chat')
  })

  it.each([
    ['Unicode-line-separator', 'one\u2028two'],
    ['blank', '   '],
    ['absent', undefined]
  ])('keeps a %s draft in the terminal, where its text actually is', (_label, launchDraftText) => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'claude',
        promptDelivery: 'draft',
        ...(launchDraftText === undefined ? {} : { launchDraftText })
      })
    ).toBeUndefined()
  })

  it('returns tab creation props only when chat should be the initial mode', () => {
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true
        },
        { agent: 'claude' }
      )
    ).toEqual({ viewMode: 'chat' })
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: false,
          openAgentTabsInChatByDefault: true
        },
        { agent: 'claude' }
      )
    ).toEqual({})
  })

  it('opens a live custom agent based on Claude in chat, draft and all', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: CUSTOM_CLAUDE_ID,
        customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')],
        promptDelivery: 'draft',
        launchDraftText: 'https://github.com/o/r/issues/12'
      })
    ).toBe('chat')
  })

  it('threads the catalog from settings through the tab-creation props', () => {
    expect(
      initialAgentTabViewModeProps(
        {
          experimentalNativeChat: true,
          openAgentTabsInChatByDefault: true,
          customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')]
        },
        { agent: CUSTOM_CLAUDE_ID }
      )
    ).toEqual({ viewMode: 'chat' })
  })

  // Fail closed: a custom id proves nothing on its own, so an unknown one and an
  // unsupported base both stay in the terminal view.
  it('keeps an uncataloged custom id and an unsupported base out of chat', () => {
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: UNCATALOGED_CUSTOM_ID,
        customTuiAgents: [customAgent(CUSTOM_CLAUDE_ID, 'claude')],
        deletedCustomTuiAgents: []
      })
    ).toBeUndefined()
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: CUSTOM_GEMINI_ID,
        customTuiAgents: [customAgent(CUSTOM_GEMINI_ID, 'gemini')]
      })
    ).toBeUndefined()
  })
})
