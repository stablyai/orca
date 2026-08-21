import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  seedNativeChatLaunchDraft: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft })
  }
}))

import { seedNativeChatLaunchDraftForAgentTab } from './agent-launch-prompt-delivery'
import { canMirrorLaunchDraftToNativeChat } from './native-chat-launch-draft-mirrorability'
import { decideInitialAgentTabViewMode } from './native-chat-initial-view-mode'
import { AGENT_TUI_CLEAR_MAX_LINES } from '../../../shared/agent-tui-input-clear'

const maxLineDraft = Array.from({ length: AGENT_TUI_CLEAR_MAX_LINES }, () => 'line').join('\n')
const overMaxLineDraft = `${maxLineDraft}\nline`

/**
 * Every shape a launch draft takes today. `formatDraftContextBlock` appends a
 * trailing newline and note+URL joins with a blank line, so the multi-line
 * cases are the majority of real draft launches, not edge cases.
 */
const DRAFT_TEXTS = [
  'https://github.com/o/r/issues/12',
  'Reproduce on Windows first\n\nhttps://github.com/o/r/issues/12',
  'Reproduce on Windows first\rhttps://github.com/o/r/issues/12',
  'Reproduce first\u2028https://github.com/o/r/issues/12',
  'Reproduce first\u2029https://github.com/o/r/issues/12',
  'ORC-123: Restore linked quick-create\nhttps://linear.app/o/issue/ORC-123',
  'ORC-123 https://linear.app/o/issue/ORC-123\n',
  '  spaced but single line  ',
  maxLineDraft,
  overMaxLineDraft,
  '',
  '   ',
  '\n'
]

function opensInChat(text: string): boolean {
  return (
    decideInitialAgentTabViewMode({
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      agent: 'claude',
      promptDelivery: 'draft',
      launchDraftText: text
    }) === 'chat'
  )
}

function seedsTheComposer(text: string): boolean {
  mocks.seedNativeChatLaunchDraft.mockClear()
  seedNativeChatLaunchDraftForAgentTab({ tabId: 'tab-1', agent: 'claude', text })
  return mocks.seedNativeChatLaunchDraft.mock.calls.length > 0
}

describe('launch draft mirrorability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Why: the whole point of the shared predicate. If either side ever grows its
  // own inline rule, a draft launch opens in chat with an empty composer beside
  // a filled TUI input (or stays in the terminal with a mirror nobody sees).
  it.each(DRAFT_TEXTS)('opens in chat exactly when it seeds: %j', (text) => {
    expect(opensInChat(text)).toBe(seedsTheComposer(text))
  })

  it.each(DRAFT_TEXTS)('both sides follow the predicate: %j', (text) => {
    const expected = canMirrorLaunchDraftToNativeChat(text)
    expect(seedsTheComposer(text)).toBe(expected)
    expect(opensInChat(text)).toBe(expected)
  })

  it('accepts CR/LF drafts and rejects unsupported Unicode line separators', () => {
    expect(canMirrorLaunchDraftToNativeChat('https://github.com/o/r/issues/12')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('one\ntwo')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('one\rtwo')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('one\u2028two')).toBe(false)
    expect(canMirrorLaunchDraftToNativeChat('one\u2029two')).toBe(false)
    expect(canMirrorLaunchDraftToNativeChat('trailing\n')).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat('   ')).toBe(false)
  })

  it('rejects drafts beyond the bounded TUI-clear budget', () => {
    expect(canMirrorLaunchDraftToNativeChat(maxLineDraft)).toBe(true)
    expect(canMirrorLaunchDraftToNativeChat(overMaxLineDraft)).toBe(false)
  })

  it('withholds the mirror from agents without a native-chat renderer', () => {
    // The view mode already returns undefined for these, so the sets still
    // agree — but only the seeding side enforces it.
    expect(seedsTheComposer('https://github.com/o/r/issues/12')).toBe(true)
    mocks.seedNativeChatLaunchDraft.mockClear()
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'tab-1',
      agent: 'gemini',
      text: 'https://github.com/o/r/issues/12'
    })
    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
    expect(
      decideInitialAgentTabViewMode({
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        agent: 'gemini',
        promptDelivery: 'draft',
        launchDraftText: 'https://github.com/o/r/issues/12'
      })
    ).toBeUndefined()
  })
})
