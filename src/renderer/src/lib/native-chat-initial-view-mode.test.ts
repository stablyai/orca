import { describe, it, expect } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import {
  decideInitialAgentTabViewMode,
  initialAgentTabViewModeProps
} from './native-chat-initial-view-mode'
import { isNativeChatTranscriptLocalReadable } from './native-chat-transcript-readability'

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
})
