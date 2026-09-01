import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteDraftWhenAgentReady: vi.fn(),
  seedNativeChatLaunchPrompt: vi.fn(),
  seedNativeChatLaunchDraft: vi.fn(),
  markNativeChatLaunchPromptFailed: vi.fn(),
  settings: {} as {
    customTuiAgents?: { id: string; baseAgent: string; label: string }[]
    deletedCustomTuiAgents?: { id: string; baseAgent: string; label: string; deletedAt: number }[]
  }
}))

const CUSTOM_CLAUDE_ID = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'
const CUSTOM_GEMINI_ID = 'custom-agent:gemini:22222222-2222-4222-8222-222222222222'
const UNCATALOGED_CUSTOM_ID = 'custom-agent:claude:33333333-3333-4333-8333-333333333333'

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mocks.pasteDraftWhenAgentReady
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchPrompt: mocks.seedNativeChatLaunchPrompt,
      seedNativeChatLaunchDraft: mocks.seedNativeChatLaunchDraft,
      markNativeChatLaunchPromptFailed: mocks.markNativeChatLaunchPromptFailed,
      settings: mocks.settings
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
    mocks.settings = {}
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

  // The composer adopts a draft only when its agent matches the pane resolution,
  // and that resolution is the BASE harness — so the seed has to be too.
  it('seeds a live custom agent draft under its base agent', () => {
    mocks.settings = {
      customTuiAgents: [{ id: CUSTOM_CLAUDE_ID, baseAgent: 'claude', label: 'My Claude' }]
    }
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'custom-tab',
      agent: CUSTOM_CLAUDE_ID,
      text: 'https://github.com/o/r/issues/12'
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith({
      tabId: 'custom-tab',
      agent: 'claude',
      text: 'https://github.com/o/r/issues/12',
      createdAt: expect.any(Number)
    })
  })

  it('seeds a tombstoned custom agent under the base its tombstone still records', () => {
    mocks.settings = {
      deletedCustomTuiAgents: [
        { id: CUSTOM_CLAUDE_ID, baseAgent: 'claude', label: 'My Claude', deletedAt: 1 }
      ]
    }
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'tombstone-tab',
      agent: CUSTOM_CLAUDE_ID,
      text: 'https://github.com/o/r/issues/12'
    })

    expect(mocks.seedNativeChatLaunchDraft).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude' })
    )
  })

  it('seeds nothing for an uncataloged custom id or an unsupported base', () => {
    mocks.settings = {
      customTuiAgents: [{ id: CUSTOM_GEMINI_ID, baseAgent: 'gemini', label: 'My Gemini' }]
    }
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'unknown-tab',
      agent: UNCATALOGED_CUSTOM_ID,
      text: 'https://github.com/o/r/issues/12'
    })
    seedNativeChatLaunchDraftForAgentTab({
      tabId: 'gemini-tab',
      agent: CUSTOM_GEMINI_ID,
      text: 'https://github.com/o/r/issues/12'
    })

    expect(mocks.seedNativeChatLaunchDraft).not.toHaveBeenCalled()
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
    mocks.settings = {}
  })

  // Registry safety (oracle 16): a custom id resolves its native-prefill behavior
  // from its base harness; a broken resolution would misreport native delivery as
  // a paste failure. claude delivers via `--prefill`, so a claude-based custom id
  // whose paste no-ops must still count as delivered.
  it('treats a custom-based native-prefill agent delivery as success', async () => {
    const customId = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'
    mocks.settings = {
      customTuiAgents: [{ id: customId, baseAgent: 'claude', label: 'My Claude' }]
    }
    mocks.pasteDraftWhenAgentReady.mockResolvedValue(false)

    await expect(
      deliverLaunchPromptToAgentTab({
        tabId: 'tab-1',
        agent: customId,
        content: 'Large generated prompt',
        submit: true,
        forcePaste: false
      })
    ).resolves.toBe(true)
    expect(mocks.markNativeChatLaunchPromptFailed).not.toHaveBeenCalled()
  })

  it('seeds a custom agent launch prompt under its base while pasting the requested id', async () => {
    mocks.settings = {
      customTuiAgents: [{ id: CUSTOM_CLAUDE_ID, baseAgent: 'claude', label: 'My Claude' }]
    }

    await deliverLaunchPromptToAgentTab({
      tabId: 'tab-1',
      agent: CUSTOM_CLAUDE_ID,
      content: 'Fix failing checks',
      submit: true,
      forcePaste: true
    })

    expect(mocks.seedNativeChatLaunchPrompt).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'Fix failing checks',
      createdAt: expect.any(Number)
    })
    // The TUI-side paste still targets the launched agent, not its base.
    expect(mocks.pasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ agent: CUSTOM_CLAUDE_ID })
    )
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
