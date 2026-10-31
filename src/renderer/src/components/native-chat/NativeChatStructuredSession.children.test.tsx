import { useAppStore } from '@/store'
// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useImperativeHandle } from 'react'
import type { NativeChatComposerProps } from './native-chat-composer-types'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../../shared/agent-session-wire'
import type { OrchestrationSessionChild } from '../../../../shared/orchestration-session-children'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSubagentRoster } from '../../../../shared/structured-agent-session-subagent-roster'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type * as HostCapability from '@/runtime/structured-agent-session-host-capability'
import type * as StructuredSessionClient from '@/runtime/structured-agent-session-client'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)
const transport = vi.hoisted(() => ({
  rpc: vi.fn(),
  read: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  capability: 'supported'
}))

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
const dropIntoParent = vi.hoisted(() => vi.fn())
vi.mock('./NativeChatComposer', () => {
  const original = moduleFactories.nativeChatComposer()
  return {
    ...original,
    NativeChatComposer: (props: NativeChatComposerProps) => {
      useNativeChatPaneFileDropClaim({
        destinationKey: 'parent-draft',
        disabled: false,
        captureExternalDrop: () => async () => {},
        onDragOverCapture: (event) => event.preventDefault(),
        onDropCapture: dropIntoParent
      })
      return <original.NativeChatComposer {...props} />
    }
  }
})
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpcClient>()),
  callRuntimeRpc: transport.rpc
}))
vi.mock('@/runtime/structured-agent-session-host-capability', async (original) => ({
  ...(await original<typeof HostCapability>()),
  useStructuredAgentSessionHostCapabilityState: () => transport.capability
}))
vi.mock('@/runtime/structured-agent-session-client', async (original) => ({
  ...(await original<typeof StructuredSessionClient>()),
  ...moduleFactories.structuredAgentSessionClient(),
  callStructuredAgentSession: transport.read,
  subscribeStructuredAgentSession: transport.subscribe
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: ({
    ref,
    session,
    subagentRoster
  }: {
    ref?: React.Ref<NativeChatMessageListHandle>
    session: NativeChatLiveSession
    subagentRoster?: StructuredAgentSubagentRoster
  }) => {
    useImperativeHandle(ref, () => ({
      revealLatest: () => {},
      revealFindMatch: () => {},
      messageCopyText: () => null
    }))
    return (
      <div data-testid={`feed:${session.sessionId}`}>
        {session.messages
          .filter((row) => row.agentId === undefined)
          .map((row) => (
            <p key={row.id}>{JSON.stringify(row.blocks)}</p>
          ))}
        <NativeChatSubagentEntries
          agents={[...(subagentRoster?.values() ?? [])].map((row) => row.entry)}
        />
      </div>
    )
  }
}))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { NativeChatChildTranscript } from './NativeChatChildTranscript'
import { NativeChatSubagentEntries } from './NativeChatSubagentRun'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import { useNativeChatSessionChildren } from './use-native-chat-session-children'

const TARGET = { kind: 'environment', environmentId: 'owner-a' } as const
const PARENT = 'parent-session'
const PARENT_MESSAGES: NativeChatMessage[] = [
  {
    id: 'parent',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Parent original conversation' }],
    timestamp: 1,
    source: 'transcript'
  }
]
let worker: OrchestrationSessionChild
let pages: Map<string, AgentSessionHistoryPage>

function message(id: string, text: string, agentId?: string): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence: Number(id.replace(/\D/g, '')) || 1,
    observedAt: 1,
    ...(agentId ? { agentId } : {}),
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}
function page(sessionId: string, items: AgentJournalRenderItem[]): AgentSessionHistoryPage {
  const cursor = { epoch: sessionId, sequence: items.at(-1)?.sequence ?? 0 }
  return {
    sessionId,
    epoch: sessionId,
    direction: 'tail',
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: items[0] ? { epoch: sessionId, sequence: items[0].sequence } : null,
      newest: cursor,
      nextCursor: cursor
    },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false
  }
}
function view(target: RuntimeClientTarget = TARGET, isVisible = true) {
  return (
    <NativeChatStructuredSession
      isVisible={isVisible}
      isFocusedGroup
      tabId="parent-tab"
      sessionId={PARENT}
      target={target}
      agent="codex"
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  transport.rpc.mockReset()
  transport.read.mockReset()
  transport.subscribe.mockReset()
  resetStructuredSessionMocks()
  resetStructuredAgentSessionReadOwnersForTests()
  transport.capability = 'supported'
  mocks.messages = PARENT_MESSAGES
  worker = {
    dispatchId: 'attempt-one',
    taskId: 'task-one',
    runId: 'run-one',
    label: 'Cross provider review',
    state: 'completed',
    workerState: 'succeeded',
    startedAt: 1,
    settledAt: 2,
    result: 'Original recorded worker result',
    conversation: {
      kind: 'journal',
      sessionId: 'worker-session',
      agent: 'claude',
      workspaceId: 'folder-workspace'
    }
  }
  pages = new Map([
    [
      'worker-session',
      page('worker-session', [
        {
          ...message('row1', 'Original worker instruction'),
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Original worker instruction' }]
          }
        },
        {
          itemId: 'row2',
          revision: 1,
          sequence: 2,
          observedAt: 1,
          body: {
            kind: 'tool-call',
            name: 'read_file',
            input: { path: 'file.ts' },
            state: 'completed',
            output: {
              head: 'Public tool result',
              byteLength: 18,
              digest: 'fixture',
              truncated: false
            }
          }
        },
        message('row3', 'Full worker answer'),
        {
          itemId: 'row4',
          revision: 1,
          sequence: 4,
          observedAt: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [
              {
                type: 'subagent-group',
                groupId: 'group',
                agents: [{ id: 'native-child', label: 'Nested native agent', state: 'completed' }]
              }
            ]
          }
        },
        message('row5', 'Nested original answer', 'native-child')
      ])
    ]
  ])
  transport.rpc.mockImplementation(async (_target, method, params) =>
    method === 'orchestration.sessionChildren'
      ? { children: params.sessionId === PARENT ? [worker] : [], nextCursor: null }
      : {}
  )
  transport.read.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.history') {
      return { ok: true, page: pages.get(params.sessionId) }
    }
    throw new Error(`Unexpected inspection method ${method}`)
  })
  transport.subscribe.mockImplementation(
    async (_target, params, emit: (event: AgentSessionSubscribeEvent) => void) => {
      const snapshot = pages.get(params.sessionId)
      if (!snapshot) {
        throw new Error('History unavailable on this host')
      }
      emit({ type: 'snapshot', sessionId: params.sessionId, page: snapshot, fence: 1 })
      return { unsubscribe: transport.unsubscribe }
    }
  )
})
afterEach(() => {
  cleanup()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
  localStorage.clear()
})

async function openWorker() {
  await screen.findByRole('button', { name: /Ran 1|1 agent|1 subagent/i })
  fireEvent.click(screen.getByRole('button', { name: /Ran 1|1 agent|1 subagent/i }))
  fireEvent.click(screen.getByRole('button', { name: /Cross provider review/ }))
  return screen.findByTestId('feed:worker-session')
}

it('opens a separate completed conversation and its native descendants, retaining parent draft and scroll', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  render(view())
  const parentFeed = screen.getByTestId(`feed:${PARENT}`)
  const composer = screen.getByRole('textbox', { name: 'Message' })
  parentFeed.scrollTop = 176
  fireEvent.change(composer, { target: { value: 'Unsent parent draft' } })
  const workerFeed = await openWorker()
  expect(workerFeed.textContent).toContain('Original worker instruction')
  expect(workerFeed.textContent).toContain('Public tool result')
  expect(workerFeed.textContent).toContain('Full worker answer')
  expect(parentFeed).not.toBeVisible()
  expect(composer).not.toBeVisible()
  const parentReads = () =>
    transport.rpc.mock.calls.filter(
      ([, method, params]) =>
        method === 'orchestration.sessionChildren' && params.sessionId === PARENT
    ).length
  const hiddenParentReads = parentReads()
  expect(fireEvent.keyDown(workerFeed, { key: 'x' })).toBe(true)
  fireEvent.paste(workerFeed, { clipboardData: { getData: () => 'Do not append to parent' } })
  expect(mocks.handlePasteEvent).not.toHaveBeenCalled()
  workerFeed.scrollTop = 93
  const childReads = () =>
    transport.rpc.mock.calls.filter(
      ([, method, params]) =>
        method === 'orchestration.sessionChildren' && params.sessionId === 'worker-session'
    ).length
  const visibleChildReads = childReads()
  expect(visibleChildReads).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: /Nested native agent/ }))
  expect(await screen.findByText(/Nested original answer/)).toBeVisible()
  const nestedFrame = screen.getByRole('region', { name: 'Nested native agent' })
  expect(within(nestedFrame).getByText('completed', { selector: 'header > span' })).toBeVisible()
  expect(within(nestedFrame).queryByRole('button', { name: 'Recorded result' })).toBeNull()
  expect(workerFeed).not.toBeVisible()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(childReads()).toBe(visibleChildReads)
  // The visible worker still refreshes its identity, without the hidden parent's duplicate poll.
  expect(parentReads()).toBe(hiddenParentReads + 1)
  expect(transport.unsubscribe).not.toHaveBeenCalled()
  expect(fireEvent.keyDown(screen.getByText(/Nested original answer/), { key: 'y' })).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Cross provider review' }))
  expect(workerFeed).toBeVisible()
  expect(screen.getByTestId('feed:worker-session')).toBe(workerFeed)
  expect(workerFeed.scrollTop).toBe(93)
  await waitFor(() => expect(childReads()).toBeGreaterThan(visibleChildReads))
  fireEvent.click(screen.getByRole('button', { name: 'Recorded result' }))
  expect(screen.getByText('Original recorded worker result')).toBeVisible()
  const readsBeforeReturn = parentReads()
  fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))
  expect(screen.getByTestId(`feed:${PARENT}`)).toBe(parentFeed)
  expect(parentFeed.scrollTop).toBe(176)
  expect(composer).toBeVisible()
  expect(composer).toHaveValue('Unsent parent draft')
  await waitFor(() => expect(parentReads()).toBeGreaterThan(readsBeforeReturn))
  expect(
    transport.read.mock.calls.every(
      ([target, method]) => target.environmentId === 'owner-a' && method === 'agentSession.history'
    )
  ).toBe(true)
  expect(
    transport.subscribe.mock.calls.every(([target]) => target.environmentId === 'owner-a')
  ).toBe(true)
  expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['hidden pane', 'failed roster refresh'])(
  'retains the same worker reader and reading position after a %s',
  async (cause) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const rendered = render(view())
    const feed = await openWorker()
    feed.scrollTop = 93
    const reads = transport.read.mock.calls.length
    if (cause === 'hidden pane') {
      rendered.rerender(view(TARGET, false))
    } else {
      transport.rpc.mockRejectedValue(new Error('Temporary roster outage'))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
    }
    expect(screen.getByTestId('feed:worker-session')).toBe(feed)
    expect(feed.scrollTop).toBe(93)
    if (cause === 'failed roster refresh') {
      expect(transport.unsubscribe).not.toHaveBeenCalled()
    }
    transport.rpc.mockResolvedValue({ children: [worker], nextCursor: null })
    rendered.rerender(view())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(screen.getByTestId('feed:worker-session')).toBe(feed)
    expect(feed.scrollTop).toBe(93)
    if (cause === 'failed roster refresh') {
      expect(transport.read.mock.calls).toHaveLength(reads)
    }
  }
)

it.each(['before', 'during'])(
  'keeps retained-history verification visible in a native descendant opened %s a roster outage',
  async (opened) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    render(view())
    await openWorker()
    const openDescendant = () =>
      fireEvent.click(screen.getByRole('button', { name: /Nested native agent/ }))
    if (opened === 'before') {
      openDescendant()
    }
    transport.rpc.mockRejectedValue(new Error('Temporary roster outage'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    if (opened === 'during') {
      openDescendant()
    }
    expect(await screen.findByText(/Nested original answer/)).toBeVisible()
    const frame = screen.getByRole('region', { name: 'Nested native agent' })
    expect(await within(frame).findByRole('status')).toHaveTextContent(
      'The worker’s identity could not be verified. Showing retained history.'
    )
  }
)

it('does not rebind an open native descendant to a worker’s replacement conversation', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  render(view())
  await openWorker()
  fireEvent.click(screen.getByRole('button', { name: /Nested native agent/ }))
  expect(await screen.findByText(/Nested original answer/)).toBeVisible()
  worker = {
    ...worker,
    conversation: {
      kind: 'journal',
      sessionId: 'replacement-session',
      agent: 'claude',
      workspaceId: 'folder-workspace'
    }
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  const frame = screen.getByRole('region', { name: 'Nested native agent' })
  expect(within(frame).queryByText(/Nested original answer/)).toBeNull()
  expect(within(frame).queryByRole('button', { name: 'Recorded result' })).toBeNull()
  expect(within(frame).getByRole('status')).toHaveTextContent(
    'This host has not supplied the agent’s conversation history.'
  )
})

it('invalidates an open child path when the parent owner changes', async () => {
  const rendered = render(view())
  await openWorker()
  const oldReads = transport.read.mock.calls.length
  rendered.rerender(view({ kind: 'environment', environmentId: 'owner-b' }))
  expect(screen.getByTestId(`feed:${PARENT}`)).toBeVisible()
  expect(screen.queryByTestId('feed:worker-session')).toBeNull()
  expect(transport.unsubscribe).toHaveBeenCalled()
  await act(async () => {})
  expect(transport.read.mock.calls).toHaveLength(oldReads)
})

it('retires the old journal reader when the same Dispatch continues into a new session', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  render(view())
  await openWorker()
  worker = {
    ...worker,
    conversation: {
      kind: 'journal',
      sessionId: 'continued-session',
      agent: 'claude',
      workspaceId: 'folder-workspace'
    }
  }
  pages.set(
    'continued-session',
    page('continued-session', [message('new1', 'Continued original answer')])
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000)
  })
  expect(screen.queryByTestId('feed:worker-session')).toBeNull()
  expect(screen.getByTestId('feed:continued-session')).toHaveTextContent(
    'Continued original answer'
  )
  expect(transport.unsubscribe).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Back to conversation' })).toBeVisible()
})

it('discards a late roster from the previous host without substituting a local owner', async () => {
  let deliverOld: ((value: unknown) => void) | undefined
  transport.rpc.mockImplementation(async (target) =>
    target.environmentId === 'owner-a'
      ? new Promise((resolve) => {
          deliverOld = resolve
        })
      : { children: [{ ...worker, label: 'New owner worker' }], nextCursor: null }
  )
  const initialProps: { target: RuntimeClientTarget } = { target: TARGET }
  const hook = renderHook(
    ({ target }: { target: RuntimeClientTarget }) =>
      useNativeChatSessionChildren({ sessionId: PARENT, target, enabled: true }),
    {
      initialProps
    }
  )
  hook.rerender({ target: { kind: 'environment', environmentId: 'owner-b' } })
  await waitFor(() => expect(hook.result.current.children[0]?.label).toBe('New owner worker'))
  await act(async () => {
    deliverOld?.({ children: [{ ...worker, label: 'Old owner worker' }], nextCursor: null })
  })
  expect(hook.result.current.children[0]?.label).toBe('New owner worker')
  expect(transport.rpc.mock.calls.every(([target]) => target.kind === 'environment')).toBe(true)
})

it.each(['supported', 'unsupported', 'unknown'])(
  'leaves an ordinary conversation quiet with no known workers on a %s host',
  async (capability) => {
    transport.capability = capability
    transport.rpc.mockResolvedValue({ children: [], nextCursor: null })
    render(view())
    await act(async () => {})
    expect(document.querySelector('[data-native-chat-session-children]')).toBeNull()
    expect(screen.queryByText('This host’s worker history is unavailable.')).toBeNull()
  }
)

it.each([
  { agent: 'claude', label: 'Claude' },
  { agent: 'codex', label: 'Codex' }
])(
  'shows the recorded local $label provider in the roster and journal frame',
  async ({ agent, label }) => {
    worker.metadata = { agent, executionHost: { kind: 'local' } }
    if (worker.conversation.kind === 'journal') {
      worker.conversation.agent = agent
    }
    render(view({ kind: 'local' }))
    await openWorker()
    const frame = screen.getByRole('region', { name: worker.label })
    expect(within(frame).getByText(label)).toBeVisible()
    expect(within(frame).getByText(/Local (Mac|Windows|Linux)|This computer/)).toBeVisible()
    expect(transport.read.mock.calls.every(([target]) => target.kind === 'local')).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
  }
)

it.each([
  { host: { kind: 'local' }, hostLabel: /Environment owner-a/, reason: 'terminal-worker' },
  {
    host: { kind: 'wsl', distro: 'Ubuntu-24.04' },
    hostLabel: /WSL · Ubuntu-24.04/,
    reason: 'remote-worker'
  },
  {
    host: { kind: 'ssh', targetId: 'ssh-review-box' },
    hostLabel: /SSH · ssh-review-box/,
    reason: 'remote-worker'
  },
  {
    host: { kind: 'environment', environmentId: 'remote-review', label: 'Build Linux' },
    hostLabel: /Build Linux/,
    reason: 'remote-worker'
  }
] as const)(
  'keeps $host.kind provider and host inspectable when full history is unavailable',
  async ({ host, hostLabel, reason }) => {
    worker.metadata = { agent: 'opencode', executionHost: host }
    worker.conversation = { kind: 'unavailable', reason }
    render(view())
    const disclosure = await screen.findByRole('button', { name: /Ran 1|1 agent|1 subagent/i })
    fireEvent.click(disclosure)
    const row = screen.getByRole('button', { name: /Cross provider review/ })
    expect(row).toHaveTextContent('OpenCode')
    expect(row).toHaveTextContent(hostLabel)
    expect(screen.getByText('Cross provider review')).toHaveTextContent(/^Cross provider review$/)
    fireEvent.click(row)
    const frame = await screen.findByRole('region', { name: worker.label })
    expect(await within(frame).findByRole('status')).toHaveTextContent(
      /unavailable|has not supplied/
    )
    expect(within(frame).getByText('OpenCode')).toBeVisible()
    expect(within(frame).getByText(hostLabel)).toBeVisible()
    expect(within(frame).getByText('Original recorded worker result')).toBeVisible()
    expect(transport.read).not.toHaveBeenCalled()
    expect(transport.subscribe).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  }
)

it('shows an unknown host explicitly when only the terminal launch agent is recorded', async () => {
  worker.metadata = { agent: 'codex' }
  worker.conversation = { kind: 'unavailable', reason: 'identity-unverifiable' }
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: /Ran 1|1 agent|1 subagent/i }))
  fireEvent.click(screen.getByRole('button', { name: /Cross provider review/ }))
  const frame = await screen.findByRole('region', { name: worker.label })
  expect(await within(frame).findByText('Unknown')).toBeVisible()
  expect(within(frame).getByRole('status')).toHaveTextContent(
    'This worker’s conversation identity could not be verified.'
  )
  expect(within(frame).getByText('Codex')).toBeVisible()
  expect(transport.read).not.toHaveBeenCalled()
})

it('keeps an older unavailable payload quiet without fabricating provider or host metadata', async () => {
  worker.conversation = { kind: 'unavailable', reason: 'terminal-worker' }
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: /Ran 1|1 agent|1 subagent/i }))
  fireEvent.click(screen.getByRole('button', { name: /Cross provider review/ }))
  const frame = await screen.findByRole('region', { name: worker.label })
  expect(await within(frame).findByRole('status')).toHaveTextContent(/unavailable/)
  expect(within(frame).queryByText('Execution host')).toBeNull()
  expect(within(frame).queryByText('Codex')).toBeNull()
  expect(transport.read).not.toHaveBeenCalled()
})

it('does not turn malformed optional metadata into an agent or SSH identity', async () => {
  worker.metadata = JSON.parse('{"agent":["claude"],"executionHost":{"kind":"ssh"}}')
  worker.conversation = { kind: 'unavailable', reason: 'terminal-worker' }
  render(view())
  fireEvent.click(await screen.findByRole('button', { name: /Ran 1|1 agent|1 subagent/i }))
  fireEvent.click(screen.getByRole('button', { name: /Cross provider review/ }))
  const frame = await screen.findByRole('region', { name: worker.label })
  expect(await within(frame).findByRole('status')).toHaveTextContent(/unavailable/)
  expect(within(frame).queryByText('Execution host')).toBeNull()
  expect(within(frame).queryByText(/undefined|SSH ·/)).toBeNull()
  expect(transport.read).not.toHaveBeenCalled()
})

it('uses the exact journal provider when optional launch metadata names a different agent', async () => {
  worker.metadata = { agent: 'codex', executionHost: { kind: 'local' } }
  render(view())
  await openWorker()
  const frame = screen.getByRole('region', { name: worker.label })
  expect(within(frame).getByText('Claude')).toBeVisible()
  expect(within(frame).queryByText('Codex')).toBeNull()
})

it.each(['unsupported', 'unknown', 'terminal', 'offline'] as const)(
  'makes %s worker history explicit without a parent or local transcript fallback',
  async (failure) => {
    if (failure === 'unsupported' || failure === 'unknown') {
      transport.capability = failure
    }
    if (failure === 'terminal') {
      worker.conversation = { kind: 'unavailable', reason: 'terminal-worker' }
    }
    if (failure === 'offline') {
      transport.rpc.mockRejectedValue(new Error('Host unavailable'))
    }
    render(
      <NativeChatChildTranscript
        child={{
          agentId: 'dispatch:attempt-one',
          label: worker.label,
          source: {
            kind: 'worker',
            target: TARGET,
            parentSessionId: PARENT,
            dispatchId: worker.dispatchId
          }
        }}
        parent={null}
        onBack={() => {}}
        session={{
          sessionId: PARENT,
          agent: 'codex',
          messages: PARENT_MESSAGES,
          status: 'ready',
          hasMore: false,
          loadingEarlier: false,
          olderHistoryGeneration: 0,
          loadEarlier: async () => 'exhausted',
          readPhase: 'ready'
        }}
        isVisible
      />
    )
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/unavailable|has not supplied/)
    )
    expect(screen.queryByText(/Parent original conversation/)).toBeNull()
    expect(transport.read).not.toHaveBeenCalled()
    expect(transport.subscribe).not.toHaveBeenCalled()
  }
)

it('does not poll the full roster every three seconds and refreshes on worker lifecycle events', async () => {
  vi.useFakeTimers()
  transport.rpc.mockImplementation(async () => ({ children: [worker], nextCursor: null }))
  const original = useAppStore.getState().agentStatusByPaneKey
  try {
    const hook = renderHook(() =>
      useNativeChatSessionChildren({ sessionId: PARENT, target: TARGET, enabled: true })
    )
    await act(async () => {})
    expect(hook.result.current.children).toHaveLength(1)
    const reads = () =>
      transport.rpc.mock.calls.filter(([, method]) => method === 'orchestration.sessionChildren')
        .length
    const initial = reads()
    expect(initial).toBeGreaterThan(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(reads()).toBe(initial)
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          ...original,
          'worker:leaf': {
            paneKey: 'worker:leaf',
            state: 'done',
            prompt: '',
            updatedAt: 1,
            stateStartedAt: 1,
            stateHistory: [],
            orchestration: { taskId: 'task', dispatchId: 'dispatch', dispatchStatus: 'completed' }
          }
        }
      })
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(reads()).toBe(initial + 1)
  } finally {
    useAppStore.setState({ agentStatusByPaneKey: original })
  }
})

it('suspends the parent file-drop claim while inspecting a child and restores it on Back', async () => {
  render(<NativeChatPaneFileDropSurface className="pane">{view()}</NativeChatPaneFileDropSurface>)
  const dataTransfer = { types: [WORKSPACE_FILE_PATH_MIME] }
  fireEvent.drop(screen.getByTestId(`feed:${PARENT}`), { dataTransfer })
  expect(dropIntoParent).toHaveBeenCalledTimes(1)
  const feed = await openWorker()
  fireEvent.dragOver(feed, { dataTransfer })
  fireEvent.drop(feed, { dataTransfer })
  expect(dropIntoParent).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))
  fireEvent.drop(screen.getByTestId(`feed:${PARENT}`), { dataTransfer })
  expect(dropIntoParent).toHaveBeenCalledTimes(2)
})
