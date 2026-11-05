// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import {
  initialStore,
  from,
  resetSenderStore,
  setSenderSessionStatus
} from './native-chat-agent-sender.test-fixture'
import * as terminalLinks from '@/components/terminal-pane/terminal-handle-links'
import * as markdown from './NativeChatMarkdown'
import * as display from '../../../../shared/agent-session/agent-message-display-text'
import type * as SonnerModule from 'sonner'
import type * as RuntimeRpc from '@/runtime/runtime-rpc-client'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { nativeChatSlotCopyText } from './native-chat-message-copy-text'
import { NativeChatAgentMessageCard } from './NativeChatAgentMessageCard'
import { MessageRow } from './NativeChatMessageRow'
import { projectStructuredAgentStartItem } from '../../../../shared/structured-agent-start-projection'
import { projectStructuredQuestionMessages } from '../../../../shared/structured-agent-question-projection'
import { desktopStructuredTranscript } from './structured-agent-session-message-projection'

import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { isAdmissibleAgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-schemas'
import { agentMessageHeading } from '../../../../shared/agent-session/agent-message-presentation'
import { nativeChatTurnFoldRow } from '../../../../shared/native-chat/transcript/native-chat-turn-fold'
import { isNoiseMessage } from '../../../../shared/native-chat/native-chat-noise'
import { nativeChatRowSpeaksOrActs } from '../../../../shared/native-chat/native-chat-trailing-run'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { orchestrationMailFixture } from '../../../../shared/agent-session/orchestration-mail.test-fixture'

it('renders and copies structured mail content without the agent envelope', async () => {
  const message = orchestrationMailFixture({ body: 'The **result** is ready.' })
  const writeClipboardText = vi.fn(async () => {})
  vi.stubGlobal('api', { ui: { writeClipboardText } })
  render(card(message))
  expect(screen.queryByText('Review complete')).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
  expect(writeClipboardText).toHaveBeenCalledWith('Review complete\n\nThe **result** is ready.')
  expect(screen.getByRole('button', { name: 'Update from worker' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Update from worker' }))
  expect(screen.getByText('Review complete')).toBeInTheDocument()
  expect(screen.getByText('result', { selector: 'strong' })).toBeInTheDocument()
  expect(screen.getByText('Review worker')).toBeInTheDocument()
  expect(screen.queryByText(/Subject:|──── From:|orchestration reply/)).toBeNull()
})

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
  expect(agentMessageHeading(message.from, message)).toBe('started')
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
  expect(screen.getByRole('button', { name: 'Build cards' })).toHaveAttribute(
    'title',
    'Build cards'
  )
  expect(screen.queryByRole('link', { name: 'a link' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Started worker' }))
  expect(screen.getByRole('link', { name: 'a link' })).toHaveAttribute(
    'href',
    'https://example.com'
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy message' })))
  expect(writeClipboardText).toHaveBeenCalledWith(task)
  expect(nativeChatSlotCopyText(slots(message), message.id)).toBe(task)
  fireEvent.click(screen.getByRole('button', { name: 'Started worker' }))
  expect(screen.getByRole('button', { name: 'Started worker' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  navigation.rpc.mockResolvedValue({ location: { kind: 'terminal', handle: 'term_0' } })
  const focus = vi.spyOn(terminalLinks, 'focusRendererTerminalHandle').mockReturnValue(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Build cards' })))
  expect(navigation.rpc).toHaveBeenCalledWith(
    { kind: 'local' },
    'orchestration.partyOpen',
    {
      address: 'term_0'
    },
    { timeoutMs: 5000 }
  )
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

it.each(['task', 'mail'] as const)(
  'keeps native %s progress independent from Markdown and reparses own edits',
  async (kind) => {
    const sessionId = testOrcaSessionId('progress-sender')
    const entry = setSenderSessionStatus(sessionId)
    const paneKey = entry.paneKey
    const prefix =
      kind === 'task' ? 'You are working inside Orca, a multi-agent IDE.\n=== TASK ===\n' : ''
    const message: NativeChatMessage = {
      id: `progress-${kind}`,
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      from: {
        ...from,
        senders: from.senders.map((sender, index) =>
          index === 0 ? { ...sender, party: { ...sender.party, orcaSessionId: sessionId } } : sender
        ),
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
    if (kind === 'mail') {
      expect(renderMarkdown).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Message from' }))
    }
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
    expect(navigation.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'orchestration.partyOpen',
      {
        address: 'term_0'
      },
      { timeoutMs: 5000 }
    )
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Other sender' })))
    expect(navigation.rpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'orchestration.partyOpen',
      { address: 'term_1' },
      { timeoutMs: 5000 }
    )
    expect(navigation.toast).toHaveBeenCalledWith(
      'The structured agent session is not available yet. Retry in a moment.'
    )
    if (kind === 'task') {
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
    }
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
    if (kind === 'mail') {
      fireEvent.click(screen.getByRole('button', { name: 'Message from' }))
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
    if (kind === 'task') {
      expect(disconnects).toBeGreaterThan(0)
    }
  }
)
