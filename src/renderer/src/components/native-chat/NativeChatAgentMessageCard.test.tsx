// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import {
  initialStore,
  from,
  status,
  resetSenderStore
} from './native-chat-agent-sender.test-fixture'
import { AGENT_SESSION_WRITE_NOTICE_COPY } from '../../../../shared/agent-session-write-notice-copy'
import * as terminalLinks from '@/components/terminal-pane/terminal-handle-links'
import * as markdown from './NativeChatMarkdown'
import * as display from '../../../../shared/agent-session/agent-message-display-text'
import type * as SonnerModule from 'sonner'
import type * as RuntimeRpc from '@/runtime/runtime-rpc-client'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredAgentStartItem } from '../../../../shared/structured-agent-start-projection'
import {
  createStructuredQuestionProjection,
  projectStructuredQuestionMessages
} from '../../../../shared/structured-agent-question-projection'
import { desktopStructuredTranscript } from './structured-agent-session-message-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../../shared/structured-agent-session-reducer'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session-journal-schemas'
import { agentMessageHeading } from '../../../../shared/agent-session/agent-message-presentation'
import { nativeChatTurnFoldRow } from '../../../../shared/native-chat/transcript/native-chat-turn-fold'
import { isNoiseMessage } from '../../../../shared/native-chat-noise'
import { nativeChatRowSpeaksOrActs } from '../../../../shared/native-chat/native-chat-trailing-run'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

it('reloads a positioned worker start into the shared card with full task, Copy and navigation', async () => {
  const task = `  Task with [a link][target].\n\n${'More task text.\n'.repeat(20)}END  \n\n[target]: https://example.com\n`
  const item: AgentJournalRenderItem = {
    itemId: 'start:dispatch',
    revision: 1,
    sequence: 7,
    observedAt: 1,
    body: { kind: 'agent-start', dispatchId: 'dispatch', worker: from.senders[0], task }
  }
  const reloaded: unknown = JSON.parse(JSON.stringify(item))
  if (!isAdmissibleAgentJournalRenderItem(reloaded)) {
    throw new Error('start item did not survive admission')
  }
  const message = projectStructuredAgentStartItem(reloaded)
  if (!message?.from) {
    throw new Error('start item did not project')
  }
  expect(message).toMatchObject({
    role: 'system',
    agentStart: true,
    journalPosition: { sequence: 7, index: 0 },
    timestamp: 1
  })
  expect(agentMessageHeading(message.from, message.agentStart)).toBe('started')
  expect(nativeChatTurnFoldRow(message, 'turn', false).outlivesTurn).toBe(true)
  expect(isNoiseMessage(message)).toBe(false)
  expect(nativeChatRowSpeaksOrActs(message, true, new Map())).toBe(false)
  const future: unknown = { ...item, body: { kind: 'future-start' } }
  if (!isAdmissibleAgentJournalRenderItem(future)) {
    throw new Error('unknown journal kind was refused')
  }
  expect(projectStructuredItemToNativeChat(future)).toBeNull()
  expect(projectStructuredAgentStartItem({ ...item, shortened: true })).toBeNull()
  expect(projectStructuredItemToNativeChat(reloaded)).toBeNull()
  height = 120
  const writeClipboardText = vi.fn(async () => {})
  vi.stubGlobal('api', { ui: { writeClipboardText } })
  render(
    <MessageRow
      message={message}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={{ worktreeId: 'wt-chat', worktreePath: null, target: { kind: 'local' } }}
    />
  )
  expect(screen.getByText('Started worker')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute(
    'href',
    'https://example.com'
  )
  expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
  expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
  expect(writeClipboardText).toHaveBeenCalledWith(task)
  expect(nativeChatSlotCopyText(slots(message), message.id)).toBe(task)
  fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
  expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  navigation.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_0' } })
  const focus = vi.spyOn(terminalLinks, 'focusRendererTerminalHandle').mockReturnValue(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build cards' })))
  expect(navigation.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.partyLocation', {
    address: 'term_0'
  })
  expect(focus).toHaveBeenCalledWith('term_0', null)
})

it.each(['', '   ', '<system-reminder>Internal noise</system-reminder>'])(
  'retains a creation fact through real tool/start/answer slots for %j',
  (task) => {
    const message = projectStructuredAgentStartItem({
      itemId: 'fact',
      revision: 1,
      sequence: 2,
      observedAt: 1,
      body: { kind: 'agent-start', dispatchId: 'd', worker: from.senders[0], task }
    })!
    for (const working of [true, false]) {
      const positioned = slots(message, true, working)
      const fact = positioned.find(
        (slot) => slot.kind === 'message' && slot.message.id === message.id
      )
      expect(fact).toMatchObject({ kind: 'message', folded: false, drawsMessage: true })
      expect(nativeChatSlotCopyText(positioned, message.id)).toBe(task)
      expect(
        positioned.some((slot) => slot.kind === 'message' && slot.message.id === 'answer')
      ).toBe(true)
    }
    render(<MessageRow message={message} expandSignal={false} onScrollMessageToTop={() => {}} />)
    expect(screen.getByText('Started worker')).toBeInTheDocument()
  }
)

it('renders unreadable worker metadata with the existing unnamed fallback and no navigation', () => {
  const raw: unknown = {
    itemId: 'future-worker',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'agent-start',
      dispatchId: 'd',
      task: 'Keep the complete task',
      worker: { futureIdentity: 'new' }
    }
  }
  if (!isAdmissibleAgentJournalRenderItem(raw)) {
    throw new Error('open metadata was refused')
  }
  const message = projectStructuredAgentStartItem(raw)!
  render(
    <MessageRow
      message={message}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={context}
    />
  )
  expect(screen.getByText('Started worker')).toBeInTheDocument()
  expect(screen.getByText('an agent')).toBeInTheDocument()
  expect(screen.getByText('Keep the complete task')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'an agent' })).toBeNull()
})

it.each([false, true])(
  'isolates canonical and desktop policy caches, desktop first=%s',
  (desktopFirst) => {
    const item: AgentJournalRenderItem = {
      itemId: 'policy-start',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'agent-start', dispatchId: 'd', worker: from.senders[0], task: 'Full task' }
    }
    const items = [item]
    if (desktopFirst) {
      desktopStructuredTranscript.messages(items)
    } else {
      projectStructuredQuestionMessages(items)
    }
    expect(projectStructuredQuestionMessages(items)).toEqual([])
    const messages = desktopStructuredTranscript.messages(items)
    expect(messages).toHaveLength(1)
    expect(desktopStructuredTranscript.messages(items)).toBe(messages)
    expect(desktopStructuredTranscript.messages([...items])[0]).toBe(messages[0])
  }
)

const navigation = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<typeof RuntimeRpc>()),
  callRuntimeRpc: navigation.rpc
}))
vi.mock('sonner', async (importOriginal) => {
  const original = await importOriginal<typeof SonnerModule>()
  return {
    ...original,
    toast: Object.assign(
      function (this: unknown, ...args: Parameters<typeof original.toast>) {
        return original.toast.apply(this, args)
      },
      original.toast,
      { error: navigation.toast }
    )
  }
})
let height = 48
let resize: () => void
let disconnects = 0
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
  navigation.rpc.mockReset()
  navigation.toast.mockReset()
  height = 48
  disconnects = 0
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => {
    return height
  })
  const computedStyle = getComputedStyle
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = computedStyle(element)
    return new Proxy(style, {
      get(target, key) {
        if (key === 'lineHeight') {
          return '24px'
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the style facade delegates native properties to the real style receiver, including binding its methods below.
        const value = target[key as keyof CSSStyleDeclaration]
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {
        disconnects++
      }
    }
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const context = { worktreeId: 'workspace', worktreePath: null, target: { kind: 'local' as const } }
function card(message: NativeChatMessage) {
  return (
    <NativeChatAgentMessageCard
      message={message}
      from={message.from!}
      runtimeContext={context}
      allowFileUriLinks={false}
      onRefolded={() => {}}
    />
  )
}
function slots(message: NativeChatMessage, surrounding = false, working = false) {
  const input: NativeChatMessage[] = surrounding
    ? [
        {
          id: 'tool',
          role: 'assistant',
          source: 'transcript',
          timestamp: 0,
          journalPosition: { sequence: 1, index: 0 },
          blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'inspect' } }]
        },
        message,
        {
          id: 'answer',
          role: 'assistant',
          source: 'transcript',
          timestamp: 2,
          journalPosition: { sequence: 3, index: 0 },
          blocks: [{ type: 'text', text: 'Final answer' }]
        }
      ]
    : [message]
  const messages = createNativeChatMessageListProjection()(input).conversation
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys: messages.map(() => (surrounding ? 'turn' : undefined)),
    liveTurnKey: working ? 'turn' : undefined,
    receipts: new Map(),
    turnStatuses: {
      active: working ? { startedAt: 1, thinking: false, workedSeconds: null } : null,
      completedByTurn:
        surrounding && !working ? { turn: { startedAt: 1, thinking: false, workedSeconds: 1 } } : {}
    },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: working,
    lifecycleWorking: working
  })
}

it('keeps a short message footer-free with copy beside the header timestamp', () => {
  const message: NativeChatMessage = {
    id: 'short-agent-message',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    from,
    blocks: [{ type: 'text', text: 'Short agent message.' }]
  }
  const { container } = render(card(message))
  expect(screen.queryByRole('button', { name: /Show more|Show less/ })).toBeNull()
  const body = screen.getByText('Short agent message.').closest('div[id]')
  expect(body).toBeInTheDocument()
  expect(body?.nextElementSibling).toBeNull()

  const copy = screen.getByRole('button', { name: 'Copy message' })
  const timestamp = container.querySelector('time')
  expect(timestamp).toBeInTheDocument()
  expect(screen.getByText('Message from').parentElement).toContainElement(copy)
  expect(copy.parentElement).toBe(timestamp?.parentElement)
})

it.each(['task', 'mail'] as const)(
  'keeps native %s progress independent from Markdown and reparses own edits',
  async (kind) => {
    const paneKey = status(0).paneKey
    const entry = {
      ...status(0),
      programStatus: { state: 'working' as const, progress: 40, observedAt: 2_000_000 }
    }
    useAppStore.setState({ agentStatusByPaneKey: { [paneKey]: entry } })
    const prefix =
      kind === 'task' ? 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n' : ''
    const message: NativeChatMessage = {
      id: `progress-${kind}`,
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      from: {
        ...from,
        orchestration:
          kind === 'task'
            ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
            : { message: 'mail-notice', mailbox: 'term_0', dispatchId: null, messages: [] }
      },
      blocks: [
        {
          type: 'text',
          text: `${prefix}Current **task** with [link](https://example.com) and ![image](https://example.com/image.png).\n\nSecond paragraph with [another link](https://example.com/second).`
        }
      ]
    }
    const convert = vi.spyOn(display, 'agentMessageTranscriptText')
    const renderMarkdown = vi.spyOn(markdown, 'NativeChatMarkdown')
    let mounted = render(card(message))
    expect(
      screen.getByText(kind === 'task' ? 'Task from coordinator' : 'Message from')
    ).toBeInTheDocument()
    expect(screen.getByText('task', { selector: 'strong' })).toBeInTheDocument()
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    expect(mounted.container.querySelectorAll('p')).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
    expect(screen.getByRole('img', { name: 'image' })).toHaveAttribute(
      'src',
      'https://example.com/image.png'
    )
    const text =
      'Current **task** with [link](https://example.com) and ![image](https://example.com/image.png).\n\nSecond paragraph with [another link](https://example.com/second).'
    const writeClipboardText = vi.fn(async () => {})
    vi.stubGlobal('api', { ui: { writeClipboardText } })
    navigation.rpc.mockRejectedValue(new Error('unreachable'))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build cards' })))
    expect(navigation.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'orchestration.partyLocation', {
      address: 'term_0'
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other sender' })))
    expect(navigation.rpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'orchestration.partyLocation',
      { address: 'term_1' }
    )
    expect(navigation.toast).toHaveBeenCalledWith(
      `${AGENT_SESSION_WRITE_NOTICE_COPY.unreachable} ${AGENT_SESSION_WRITE_NOTICE_COPY.tryAgain}`
    )
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    act(() => {
      height = 120
      resize()
    })
    const more = screen.getByRole('button', { name: 'Show more' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    const clip = document.getElementById(more.getAttribute('aria-controls')!)!
    const first = screen.getByRole('link', { name: 'link' })
    const second = screen.getByRole('link', { name: 'another link' })
    const documentFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    first.focus()
    clip.scrollTop = 74
    second.focus()
    expect(second).toHaveFocus()
    expect(clip.scrollTop).toBe(74)
    documentFocus.mockReturnValue(false)
    second.blur()
    expect(clip.scrollTop).toBe(74)
    documentFocus.mockReturnValue(true)
    second.focus()
    more.focus()
    expect(more).toHaveFocus()
    expect(clip.scrollTop).toBe(0)
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
    expect(writeClipboardText).toHaveBeenCalledWith(text)
    expect(nativeChatSlotCopyText(slots(message), message.id)).toBe(text)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }))
    act(() => {
      height = 48
      resize()
    })
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
    for (const remount of [false, true]) {
      if (remount) {
        mounted.unmount()
        mounted = render(card(message))
      }
      const ring = screen.getByRole('progressbar', { name: 'Working · 40%' })
      expect(ring).toHaveAttribute('aria-valuenow', '40')
      expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
        'stroke-dasharray',
        '40 100'
      )
    }
    for (const spy of [convert, renderMarkdown]) {
      spy.mockClear()
    }
    for (const progress of [60, null, 60, 0, 100]) {
      act(() =>
        useAppStore
          .getState()
          .setAgentProgramStatus(
            paneKey,
            progress === null ? null : { state: 'working', progress, observedAt: 2_000_000 }
          )
      )
      if (progress === null) {
        expect(screen.queryByRole('progressbar')).toBeNull()
        expect(screen.getByLabelText('Working')).toBeInTheDocument()
      } else {
        const ring = screen.getByRole('progressbar', { name: `Working · ${progress}%` })
        expect(ring).toHaveAttribute('aria-valuenow', String(progress))
        expect(ring.querySelector('circle[pathLength="100"]')).toHaveAttribute(
          'stroke-dasharray',
          `${progress} 100`
        )
        expect(screen.queryByLabelText('Done')).toBeNull()
      }
      for (const spy of [convert, renderMarkdown]) {
        expect(spy).not.toHaveBeenCalled()
      }
    }
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: { [paneKey]: { ...entry, state: 'done' } },
        agentStatusEpoch: 2
      })
    )
    expect(screen.getByLabelText('Done')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).toBeNull()
    for (const spy of [convert, renderMarkdown]) {
      expect(spy).not.toHaveBeenCalled()
    }
    const edited = { ...message, blocks: [{ type: 'text' as const, text: `${prefix}Edited task` }] }
    mounted.rerender(card(edited))
    expect(screen.getByText('Edited task')).toBeInTheDocument()
    expect(convert).toHaveBeenCalled()
    expect(renderMarkdown).toHaveBeenCalled()
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    await act(async () => fireEvent.click(copyButton))
    expect(copyButton).toHaveAccessibleName('Copied')
    expect(writeClipboardText).toHaveBeenCalledWith('Edited task')
    expect(nativeChatSlotCopyText(slots(edited), edited.id)).toBe('Edited task')
    const multiple: NativeChatMessage = {
      ...edited,
      blocks: [...edited.blocks, { type: 'text', text: 'Another paragraph' }]
    }
    mounted.rerender(card(multiple))
    await act(async () => fireEvent.click(copyButton))
    expect(writeClipboardText).toHaveBeenCalledWith(`${prefix}Edited task\n\nAnother paragraph`)
    expect(nativeChatSlotCopyText(slots(multiple), multiple.id)).toBe(
      `${prefix}Edited task\n\nAnother paragraph`
    )
    mounted.unmount()
    expect(disconnects).toBeGreaterThan(0)
  }
)

it.each([10, 100])(
  'bounds real publication work and settled body renders with %i starts',
  async (count) => {
    let itemVisits = 0
    let taskReads = 0
    let listVisits = 0
    let conversions = 0
    const projection = createStructuredQuestionProjection((item) => {
      conversions++
      return projectStructuredAgentStartItem(item)
    })
    const ordinary: AgentJournalRenderItem[] = Array.from({ length: 9 * count }, (_, index) => ({
      itemId: `ordinary-${index}`,
      revision: 1,
      sequence: index + 1,
      observedAt: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `History ${index}` }]
      }
    }))
    const starts: AgentJournalRenderItem[] = Array.from({ length: count }, (_, index) => {
      const body = {
        kind: 'agent-start' as const,
        dispatchId: `d-${index}`,
        worker: from.senders[0],
        get task() {
          taskReads++
          return `Task ${index}`
        }
      }
      return {
        itemId: `start-${index}`,
        revision: 1,
        sequence: ordinary.length + index + 1,
        observedAt: 1,
        get body() {
          itemVisits++
          return body
        }
      }
    })
    const items = [...ordinary, ...starts]
    const page: AgentSessionHistoryPage = {
      sessionId: 'scale',
      epoch: 'scale-epoch',
      direction: 'tail',
      items,
      removedItemIds: [],
      submissions: [],
      window: {
        oldest: { epoch: 'scale-epoch', sequence: 1 },
        newest: { epoch: 'scale-epoch', sequence: items.length },
        nextCursor: { epoch: 'scale-epoch', sequence: 1 }
      },
      liveCursor: { epoch: 'scale-epoch', sequence: items.length },
      hasOlder: false,
      hasNewer: false
    }
    let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page
    })
    const readRows = () => {
      const counted = state.items.slice()
      counted.forEach((item, index) => {
        Object.defineProperty(counted, index, {
          get() {
            listVisits++
            return item
          }
        })
      })
      return projection.messages(counted).filter(({ agentStart }) => agentStart)
    }
    let messages = readRows()
    expect(conversions).toBe(items.length)
    expect(taskReads).toBe(count)
    // One existing question pass visits the source array once; the second pass visits its composed rows.
    expect(listVisits).toBe(items.length)
    expect(itemVisits).toBeLessThan(100 * items.length)
    const markdownRender = vi.spyOn(markdown, 'NativeChatMarkdown')
    const scroll = () => {}
    const rows = () => (
      <>
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            runtimeContext={context}
            expandSignal={false}
            onScrollMessageToTop={scroll}
          />
        ))}
      </>
    )
    const mounted = render(rows())
    await act(async () => {})
    markdownRender.mockClear()
    navigation.rpc.mockClear()
    itemVisits = taskReads = listVisits = conversions = 0
    // Real history publication with identical immutable rows must reuse their body construction.
    state = reduceStructuredAgentSession(state, {
      type: 'history-page',
      page: { ...page, items: [...items] }
    })
    messages = readRows()
    await act(async () => mounted.rerender(rows()))
    expect(conversions).toBe(0)
    expect(taskReads).toBe(0)
    expect(listVisits).toBe(items.length)
    expect(itemVisits).toBeLessThan(100 * items.length)
    expect(markdownRender).not.toHaveBeenCalled()
    const unrelated: AgentJournalRenderItem = {
      itemId: 'new-answer',
      revision: 1,
      sequence: items.length + 1,
      observedAt: 2,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Another row streams' }]
      }
    }
    state = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'scale',
        batch: {
          cursor: { epoch: 'scale-epoch', sequence: items.length + 1 },
          items: [unrelated],
          removedItemIds: [],
          submissions: []
        }
      }
    })
    messages = readRows()
    await act(async () => mounted.rerender(rows()))
    expect(conversions).toBe(1)
    expect(taskReads).toBe(0)
    expect(markdownRender).not.toHaveBeenCalled()
    conversions = 0
    // A relevant live revision updates its own body in a distinct act turn.
    const revised: AgentJournalRenderItem = {
      ...starts[0],
      revision: 2,
      body: {
        kind: 'agent-start',
        dispatchId: 'd-0',
        worker: from.senders[0],
        task: 'Changed task'
      }
    }
    state = reduceStructuredAgentSession(state, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'scale',
        batch: {
          cursor: { epoch: 'scale-epoch', sequence: items.length + 2 },
          items: [revised],
          removedItemIds: [],
          submissions: []
        }
      }
    })
    messages = readRows()
    await act(async () => mounted.rerender(rows()))
    expect(conversions).toBe(1)
    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Changed task')).toBeInTheDocument()
    expect(
      navigation.rpc.mock.calls.filter(([, method]) =>
        /agentSession\.item|capabilit/i.test(String(method))
      )
    ).toEqual([])
  }
)
