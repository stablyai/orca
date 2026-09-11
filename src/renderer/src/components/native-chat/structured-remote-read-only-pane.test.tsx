// @vitest-environment happy-dom
//
// This release advertises that it can READ a paired host's structured chats, and that is the whole
// of it. The host is willing — it admits the hold to any client that advertises the reader — so the
// only thing standing between a restored chat row and a provider child waking up on somebody else's
// machine is this pane. These are that guard.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../../shared/structured-agent-session-reducer'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { structuredTabOwnerBinding } from '@/runtime/structured-tab-owner'
import { buildMirroredAgentTabs } from '@/runtime/web-session-tabs-sync/terminal-surfaces'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

// A host with every structured capability: the pane must refuse itself, not be refused.
const hostMocks = vi.hoisted(() => ({ supportsCapability: vi.fn(async () => true) }))

vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: hostMocks.supportsCapability
}))
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: readState,
    loadingOlder: false,
    loadOlder: vi.fn(),
    providerSession: undefined
  })
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const ENVIRONMENT_ID = 'env-paired'
const SESSION_ID = 'session-restored'

const transcriptItem: AgentJournalRenderItem = {
  itemId: 'item-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Last answer.' }] }
}

/** The transcript the host published; a read-only pane still shows all of it. */
const readState = {
  ...EMPTY_STRUCTURED_AGENT_SESSION,
  epoch: 'epoch-1',
  fence: 1,
  status: 'ready' as const,
  items: [transcriptItem],
  commands: null
}

/** A worktree the paired host was already holding a chat in before this client ever connected. */
function preExistingHostSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'wt-paired',
    publicationEpoch: 'epoch-1',
    snapshotVersion: 4,
    activeGroupId: 'group-1',
    activeTabId: `agent-session:${SESSION_ID}`,
    activeTabType: 'agent-session',
    tabs: [
      {
        type: 'agent-session',
        id: `agent-session:${SESSION_ID}`,
        title: 'Codex Chat',
        sessionId: SESSION_ID,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

/**
 * The tab the mirror really builds from that snapshot, then the owner binding the pane really
 * reads off it. Going through both is the point: a pane handed a hand-written environment target
 * proves nothing about what a restored host row turns into.
 */
function paneFromRestoredHostRow(): { target: { kind: string }; stale: boolean } {
  const mirrored = buildMirroredAgentTabs(
    preExistingHostSnapshot(),
    new Map(),
    'group-1',
    0,
    [],
    1,
    `runtime:${ENVIRONMENT_ID}`
  )
  const stamp = mirrored[0]?.unifiedTab
  if (!stamp) {
    throw new Error('the mirror built no tab for a published structured row')
  }
  const binding = structuredTabOwnerBinding(stamp, null)
  return { target: binding.target, stale: binding.ownerPairingStale }
}

function renderRestoredPane(): void {
  const { target, stale } = paneFromRestoredHostRow()
  expect(target, 'the restored row must bind to its paired owner').toMatchObject({
    kind: 'environment',
    environmentId: ENVIRONMENT_ID
  })
  // Not the re-paired degraded state: this pane is read-only while its owner is perfectly current.
  expect(stale).toBe(false)
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="tab-1"
      sessionId={SESSION_ID}
      target={target as { kind: 'environment'; environmentId: string }}
      ownerPairingRevision={7}
      agent="codex"
    />
  )
}

function callsTo(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((call) => call[1] === method)
}

beforeEach(() => {
  replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 7, pairingRevision: 7 }])
  hostMocks.supportsCapability.mockClear()
  mocks.call.mockImplementation(async (_target: unknown, method: string) =>
    method === 'agentSession.options'
      ? { current: { model: 'gpt-live' }, models: [], conversationCommands: [] }
      : {}
  )
})

afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
  replaceRuntimeEnvironmentRevisions([])
})

describe('a structured chat restored from a paired host', () => {
  it('renders the transcript without waking anything on the host that owns it', async () => {
    renderRestoredPane()

    expect(await screen.findByTestId('message-list')).toBeTruthy()
    // The one call that opens a durable record on the other machine and hands its session a
    // provider child back. A read-only pane must never make it, and must not even negotiate it:
    // the host here advertises everything, so a pane that asked would have been told yes.
    await waitFor(() => expect(mocks.composerProps?.canSend).toBe(false))
    expect(callsTo('agentSession.hold')).toHaveLength(0)
    expect(callsTo('agentSession.release')).toHaveLength(0)
    expect(hostMocks.supportsCapability).not.toHaveBeenCalled()
  })

  it('says why it is read-only in terms of this client, not of the host', async () => {
    renderRestoredPane()

    const notice = await screen.findByText(/runs on a paired host/i)
    expect(notice.dataset.nativeChatRemote).toBe('read-only')
    // The lifetime sentence this stack is required to use. "Work continues while you are away"
    // describes a PTY and is false for a structured session.
    expect(notice.textContent).toContain(
      'The in-flight turn and its approvals survive going offline; idle sessions park after about 15 seconds and resume on demand.'
    )
    expect(notice.textContent).not.toMatch(/work continues/i)
    // Not the update prompt and not the lost-contact pane: neither is true of this host.
    expect(document.querySelector('[data-native-chat-hold]')).toBeNull()
  })

  it('sends no mutation, whatever the pane is asked to do', async () => {
    renderRestoredPane()

    await waitFor(() => expect(mocks.composerProps?.canSend).toBe(false))
    const transport = mocks.composerProps?.structuredTransport as
      | { send?: (text: string, attachments: readonly unknown[]) => boolean }
      | undefined
    expect(transport?.send, 'the composer was never handed a transport').toBeTypeOf('function')
    expect(transport?.send?.('hello', [])).toBe(false)
    for (const method of [
      'agentSession.hold',
      'agentSession.send',
      'agentSession.cancel',
      'agentSession.setOption',
      'agentSession.respondToApproval',
      'agentSession.respondToQuestion',
      'agentSession.conversationCommand'
    ]) {
      expect(callsTo(method), `${method} reached the paired host`).toHaveLength(0)
    }
    // Anti-vacuous: the pane is talking to the host, just only ever reading it.
    expect(callsTo('agentSession.options').length).toBeGreaterThan(0)
  })
})
