import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import {
  anchorPromptCacheTimerToTranscript,
  lastRequestTimestamp,
  resolvePromptCacheTranscriptSource
} from './prompt-cache-transcript-anchor'

const readSession = vi.fn()

vi.mock('@/components/native-chat/native-chat-session-transport', () => ({
  getNativeChatSessionTransport: () => ({ readSession, subscribe: vi.fn() })
}))

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/work/tree'
const SESSION_ID = '22222222-2222-4222-8222-222222222222'
const TRANSCRIPT_PATH = `/home/user/.claude/projects/work-tree/${SESSION_ID}.jsonl`

function message(role: NativeChatMessage['role'], timestamp: number | null): NativeChatMessage {
  return {
    id: `${role}-${timestamp}`,
    role,
    blocks: [{ type: 'text', text: role }],
    timestamp,
    source: 'transcript'
  }
}

function claudeRow(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 1_700_000_000_000,
    stateStartedAt: 1_700_000_000_000,
    agentType: 'claude',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    stateHistory: [],
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT_PATH },
    ...overrides
  }
}

function sleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT_PATH },
    prompt: '',
    state: 'done',
    capturedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    connectionId: null,
    origin: 'live',
    ...overrides
  }
}

describe('lastRequestTimestamp', () => {
  it('returns the newest prompt or tool result and skips interruption notices', () => {
    expect(
      lastRequestTimestamp([
        message('user', 100),
        message('assistant', 200),
        message('tool', 300),
        message('assistant', 250),
        message('system', 400)
      ])
    ).toBe(300)
  })

  it('prefers the request over a later reply', () => {
    expect(lastRequestTimestamp([message('user', 100), message('assistant', 9_000)])).toBe(100)
  })

  it('falls back to the newest reply when the tail holds no request', () => {
    expect(lastRequestTimestamp([message('assistant', 100), message('reasoning', 200)])).toBe(200)
  })

  it('returns null when no conversation record has a timestamp', () => {
    expect(lastRequestTimestamp([message('assistant', null), message('system', 100)])).toBeNull()
  })
})

describe('resolvePromptCacheTranscriptSource', () => {
  it('uses the local Claude hook row', () => {
    const store = createTestStore()
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: claudeRow() } })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: TRANSCRIPT_PATH,
      worktreeId: WORKTREE_ID
    })
  })

  it('skips SSH relay rows, whose transcript is on the remote machine', () => {
    const store = createTestStore()
    store.setState({
      agentStatusByPaneKey: { [PANE_KEY]: claudeRow({ connectionId: 'ssh-1' }) }
    })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toBeNull()
  })

  it('skips non-Claude rows', () => {
    const store = createTestStore()
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: claudeRow({ agentType: 'codex' }) } })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toBeNull()
  })

  it('falls back to the persisted sleep checkpoint before the hook row returns', () => {
    const store = createTestStore()
    store.setState({ sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepingRecord() } })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toEqual({
      sessionId: SESSION_ID,
      transcriptPath: TRANSCRIPT_PATH,
      worktreeId: WORKTREE_ID
    })
  })

  it('skips unstamped sleep checkpoints on an SSH worktree', () => {
    const store = createTestStore()
    store.setState({
      repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: 'remote' }],
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: WORKTREE_ID, repoId: 'repo-1', hostId: 'ssh:remote' })]
      },
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: sleepingRecord({ connectionId: undefined })
      }
    })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toBeNull()
  })

  it('does not fall back to the sleep checkpoint while a live row has no session', () => {
    const store = createTestStore()
    store.setState({
      agentStatusByPaneKey: { [PANE_KEY]: claudeRow({ providerSession: undefined }) },
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: sleepingRecord() }
    })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toBeNull()
  })

  it('skips a pane that dropped back to its shell', () => {
    const store = createTestStore()
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: claudeRow() } })
    store.getState().setPaneForegroundAgent(PANE_KEY, { agent: null, shellForeground: true })

    expect(resolvePromptCacheTranscriptSource(store.getState(), PANE_KEY)).toBeNull()
  })

  it('ignores seed sentinel keys', () => {
    const store = createTestStore()
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: claudeRow() } })

    expect(resolvePromptCacheTranscriptSource(store.getState(), 'tab-1:seed')).toBeNull()
  })
})

describe('anchorPromptCacheTimerToTranscript', () => {
  beforeEach(() => {
    readSession.mockReset()
  })

  function setup(startedAt: number) {
    const store = createTestStore()
    store.setState({
      agentStatusByPaneKey: { [PANE_KEY]: claudeRow() },
      cacheTimerByKey: { [PANE_KEY]: startedAt }
    })
    const applyAnchor = vi.fn()
    return { store, applyAnchor }
  }

  it('moves the countdown start back to the last request', async () => {
    const { store, applyAnchor } = setup(10_000)
    readSession.mockResolvedValue({
      messages: [message('assistant', 4_000), message('tool', 5_000)],
      hasMore: false
    })

    await anchorPromptCacheTimerToTranscript({
      paneKey: PANE_KEY,
      startedAt: 10_000,
      getState: store.getState,
      applyAnchor
    })

    expect(readSession).toHaveBeenCalledWith('claude', SESSION_ID, 40, TRANSCRIPT_PATH)
    expect(applyAnchor).toHaveBeenCalledWith(5_000)
  })

  it('never moves the countdown start later', async () => {
    const { store, applyAnchor } = setup(10_000)
    readSession.mockResolvedValue({ messages: [message('assistant', 12_000)], hasMore: false })

    await anchorPromptCacheTimerToTranscript({
      paneKey: PANE_KEY,
      startedAt: 10_000,
      getState: store.getState,
      applyAnchor
    })

    expect(applyAnchor).not.toHaveBeenCalled()
  })

  it('leaves a countdown that changed during the read alone', async () => {
    const { store, applyAnchor } = setup(10_000)
    readSession.mockImplementation(async () => {
      store.setState({ cacheTimerByKey: { [PANE_KEY]: null } })
      return { messages: [message('assistant', 4_000)], hasMore: false }
    })

    await anchorPromptCacheTimerToTranscript({
      paneKey: PANE_KEY,
      startedAt: 10_000,
      getState: store.getState,
      applyAnchor
    })

    expect(applyAnchor).not.toHaveBeenCalled()
  })

  it('keeps the countdown when the transcript cannot be read', async () => {
    const { store, applyAnchor } = setup(10_000)
    readSession.mockResolvedValueOnce({ error: 'Transcript unavailable', notFound: true })

    await anchorPromptCacheTimerToTranscript({
      paneKey: PANE_KEY,
      startedAt: 10_000,
      getState: store.getState,
      applyAnchor
    })
    readSession.mockRejectedValueOnce(new Error('ipc closed'))
    await anchorPromptCacheTimerToTranscript({
      paneKey: PANE_KEY,
      startedAt: 10_000,
      getState: store.getState,
      applyAnchor
    })

    expect(applyAnchor).not.toHaveBeenCalled()
  })
})

describe('setCacheTimerStartedAt transcript anchoring', () => {
  beforeEach(() => {
    readSession.mockReset()
  })

  it('anchors a new countdown to the transcript', async () => {
    const store = createTestStore()
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: claudeRow() } })
    readSession.mockResolvedValue({ messages: [message('assistant', 4_000)], hasMore: false })

    store.getState().setCacheTimerStartedAt(PANE_KEY, 10_000)

    await vi.waitFor(() => expect(store.getState().cacheTimerByKey[PANE_KEY]).toBe(4_000))
  })

  it('does not re-read the transcript for a redundant write or a clear', () => {
    const store = createTestStore()
    store.setState({
      agentStatusByPaneKey: { [PANE_KEY]: claudeRow() },
      cacheTimerByKey: { [PANE_KEY]: 10_000 }
    })

    store.getState().setCacheTimerStartedAt(PANE_KEY, 10_000)
    store.getState().setCacheTimerStartedAt(PANE_KEY, null)

    expect(readSession).not.toHaveBeenCalled()
  })
})
