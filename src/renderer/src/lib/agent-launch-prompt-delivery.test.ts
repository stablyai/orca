import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn()
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed
    })
  }
}))

import {
  deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab
} from './agent-launch-prompt-delivery'

describe('seedNativeChatLaunchDraftForAgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('mirrors multi-line text — the majority of real drafts', () => {
    // A Linear draft is always `Linked Linear issue: …\n<url>\n`, so rejecting
    // newlines made every Linear launch invisible in chat. Send now clears every
    // parked line first, so there is nothing left to glue.
    const text = 'Linked Linear issue: STA-1234\nhttps://linear.app/o/issue/STA-1234\n'
    seedNativeChatLaunchDraftForAgentTab({ tabId: 'linear-tab', agent: 'codex', text })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'linear-tab',
      agent: 'codex',
      text,
      createdAt: expect.any(Number)
    })
  })

  it('seeds single-line text', () => {
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'issue-tab',
      agent: 'codex',
      text: 'https://github.com/o/r/issues/12'
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'issue-tab',
      agent: 'codex',
      text: 'https://github.com/o/r/issues/12',
      createdAt: expect.any(Number)
    })
  })
})

describe('deliverLaunchPromptToAgentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(true)
  })

  it('seeds a native-chat launch prompt for supported submitted content', async () => {
    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'codex',
        content: 'Fix failing checks',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      text: 'Fix failing checks',
      createdAt: expect.any(Number)
    })
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: undefined,
      onTimeout: undefined
    })
  })

  it('does not seed a launch prompt for drafts, unsupported agents, or empty content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'unsupported-tab',
      agent: 'gemini',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'empty-tab',
      agent: 'claude',
      content: '   ',
      submit: true,
      forcePaste: true
    })

    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('seeds a native-chat launch draft for supported unsubmitted content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'draft-tab',
      agent: 'codex',
      text: 'Review first',
      createdAt: expect.any(Number)
    })
    expect(mocks.seedNativeChatLaunchPrompt).not.toHaveBeenCalled()
  })

  it('seeds a launch draft for multi-line content', async () => {
    // Note+URL launches join with a blank line, so this shape is common too.
    const content = 'Forked from session\n\nhttps://example.test/context'
    await deliverLaunchPromptToAgentTab({
      tabId: 'fork-tab',
      agent: 'codex',
      content,
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'fork-tab',
      agent: 'codex',
      text: content,
      createdAt: expect.any(Number)
    })
  })

  it('does not seed a launch draft for submitted, unsupported, or empty content', async () => {
    await deliverLaunchPromptToAgentTab({
      tabId: 'submit-tab',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'unsupported-tab',
      agent: 'gemini',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })
    await deliverLaunchPromptToAgentTab({
      tabId: 'empty-tab',
      agent: 'claude',
      content: '   ',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
  })

  it('keeps the seeded launch draft when paste delivery fails', async () => {
    // A paste timeout means the TUI never got the draft — the composer copy is
    // then the only copy, so it must not be flagged or cleared.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await deliverLaunchPromptToAgentTab({
      tabId: 'draft-tab',
      agent: 'codex',
      content: 'Review first',
      submit: false,
      forcePaste: false
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('marks a seeded launch prompt failed when paste delivery returns false', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: true
      })
    ).resolves.toBe(false)

    expect(mocks.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
  })

  it('marks a seeded launch prompt failed when paste delivery rejects', async () => {
    const error = new Error('prompt transport rejected')
    mocks.pasteDraftWhenAgentReady.mockRejectedValue(error)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'codex',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: true
      })
    ).rejects.toBe(error)

    expect(mocks.markNativeChatLaunchPromptFailed).toHaveBeenCalledWith('tab-1')
  })

  it('treats native-prefill delivery as success without flagging the seeded prompt', async () => {
    // claude delivers via `--prefill` at launch, so paste no-ops (returns false)
    // when forcePaste is false — that is a native delivery, not a failure.
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: 'claude',
        content: 'Large generated prompt',
        submit: true,
        forcePaste: false
      })
    ).resolves.toBe(true)

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalled()
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('does not mark unseeded launches failed', async () => {
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'gemini',
      content: 'Large generated prompt',
      submit: true,
      forcePaste: true
    })

    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('passes timeout options through to the paste transport', async () => {
    const onTimeout = vi.fn()

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: 'codex',
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true,
      timeoutMs: 123,
      onTimeout
    })

    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 123, onTimeout })
    )
  })
})
