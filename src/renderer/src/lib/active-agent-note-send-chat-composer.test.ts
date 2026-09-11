import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  seedNoteAsChatComposerDraft,
  sendNotesToActiveAgentSession
} from './active-agent-note-send'
import {
  createNoteSendAppState,
  LEAF_ID,
  type NoteSendAppState
} from './active-agent-note-send-test-harness'

const testState = vi.hoisted(() => ({
  appState: null as unknown as NoteSendAppState,
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn(() => ({ kind: 'local' })),
  seedDraft: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: NoteSendAppState) => unknown) => selector(testState.appState),
    { getState: () => testState.appState }
  )
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: testState.callRuntimeRpc,
  getActiveRuntimeTarget: testState.getActiveRuntimeTarget,
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {}
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  seedNativeChatLaunchDraftForAgentTab: testState.seedDraft,
  deliverLaunchPromptToAgentTab: vi.fn()
}))

// U+2028 line separator: real predicate treats this as terminal-only.
const UNMIRRORABLE = 'first second'

describe('seedNoteAsChatComposerDraft (chat-view routing gate)', () => {
  beforeEach(() => {
    testState.seedDraft.mockReset()
  })

  it('seeds the composer when the tab shows the chat view', () => {
    const result = seedNoteAsChatComposerDraft({
      viewMode: 'chat',
      launchAgent: 'claude',
      tabId: 'tab-1',
      text: 'review this'
    })
    expect(result).toEqual({ status: 'sent' })
    expect(testState.seedDraft).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'review this'
    })
  })

  it('falls back to the terminal when the tab shows the terminal view', () => {
    expect(
      seedNoteAsChatComposerDraft({
        viewMode: 'terminal',
        launchAgent: 'claude',
        tabId: 'tab-1',
        text: 'review this'
      })
    ).toBeNull()
    expect(testState.seedDraft).not.toHaveBeenCalled()
  })

  it('falls back to the terminal when the view mode is unresolved', () => {
    expect(
      seedNoteAsChatComposerDraft({
        viewMode: undefined,
        launchAgent: 'claude',
        tabId: 'tab-1',
        text: 'review this'
      })
    ).toBeNull()
    expect(testState.seedDraft).not.toHaveBeenCalled()
  })

  it('falls back to the terminal when the tab has no launch agent', () => {
    expect(
      seedNoteAsChatComposerDraft({
        viewMode: 'chat',
        launchAgent: undefined,
        tabId: 'tab-1',
        text: 'review this'
      })
    ).toBeNull()
    expect(testState.seedDraft).not.toHaveBeenCalled()
  })

  it('falls back to the terminal when the note cannot be mirrored', () => {
    expect(
      seedNoteAsChatComposerDraft({
        viewMode: 'chat',
        launchAgent: 'claude',
        tabId: 'tab-1',
        text: UNMIRRORABLE
      })
    ).toBeNull()
    expect(testState.seedDraft).not.toHaveBeenCalled()
  })
})

describe('sendNotesToActiveAgentSession chat-composer wiring', () => {
  beforeEach(() => {
    testState.appState = createNoteSendAppState()
    testState.callRuntimeRpc.mockReset()
    testState.getActiveRuntimeTarget.mockClear()
    testState.getActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
    testState.seedDraft.mockReset()
  })

  it('routes to the composer off the live view mode (getTab), not the terminal record', async () => {
    // The live view mode lives on the unified tab (getTab); the agent on the
    // terminal record. Reading viewMode from tabsByWorktree, which never sees the
    // chat toggle, is the exact regression this guards.
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', launchAgent: 'claude' }] }
    testState.appState.getTab = () => ({ id: 'tab-1', viewMode: 'chat' })

    await expect(
      sendNotesToActiveAgentSession({
        worktreeId: 'wt-1',
        prompt: 'ship it',
        noteTarget: { tabId: 'tab-1', leafId: LEAF_ID }
      })
    ).resolves.toEqual({ status: 'sent' })

    expect(testState.seedDraft).toHaveBeenCalledWith({
      tabId: 'tab-1',
      agent: 'claude',
      text: 'ship it'
    })
    expect(testState.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends to the terminal when the live view mode is terminal', async () => {
    testState.appState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', launchAgent: 'claude' }] }
    testState.appState.getTab = () => ({ id: 'tab-1', viewMode: 'terminal' })
    testState.callRuntimeRpc.mockResolvedValue({ terminals: [], totalCount: 0, truncated: false })

    await sendNotesToActiveAgentSession({
      worktreeId: 'wt-1',
      prompt: 'ship it',
      noteTarget: { tabId: 'tab-1', leafId: LEAF_ID }
    })

    expect(testState.seedDraft).not.toHaveBeenCalled()
    expect(testState.callRuntimeRpc).toHaveBeenCalled()
  })
})
