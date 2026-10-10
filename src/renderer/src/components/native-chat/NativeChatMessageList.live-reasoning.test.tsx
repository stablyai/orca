// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { projectNativeChatTaskListFrames } from './native-chat-task-list-frames'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'
import { projectStructuredQuestionMessages } from './structured-agent-question-projection'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

{
  const STARTED = 1_000

  const prompt: NativeChatMessage = {
    id: 'user-1',
    role: 'user',
    blocks: [{ type: 'text', text: 'Start the task' }],
    timestamp: STARTED - 500,
    source: 'transcript'
  }

  function reasoning(
    id: string,
    text: string,
    state: 'running' | 'completed',
    fields: Partial<NativeChatMessage> = {}
  ): NativeChatMessage {
    return {
      id,
      role: 'reasoning',
      blocks: [{ type: 'text', text }],
      timestamp: STARTED,
      source: 'transcript',
      state,
      ...(state === 'completed' ? { completedAt: STARTED + 12_000 } : {}),
      ...fields
    }
  }

  /** The journal that says the turn runs and what its newest content is. */
  function journal(rows: readonly NativeChatMessage[]): AgentJournalRenderItem[] {
    return [
      {
        itemId: prompt.id,
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'message', role: 'user', blocks: prompt.blocks }
      },
      {
        itemId: 'turn-1',
        revision: 1,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId: prompt.id }
      },
      ...rows.map((row, index) => ({
        itemId: row.id,
        revision: 1,
        sequence: index + 3,
        observedAt: index + 3,
        ...(row.agentId ? { agentId: row.agentId } : {}),
        body: {
          kind: 'message' as const,
          role: row.role,
          blocks: row.blocks,
          ...(row.state ? { state: row.state } : {})
        }
      }))
    ]
  }

  function sessionOf(messages: NativeChatMessage[]): NativeChatLiveSession {
    return {
      messages,
      status: 'working',
      sessionId: 'session-1',
      agent: 'claude',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    }
  }

  function list(
    rows: readonly NativeChatMessage[],
    props: Partial<React.ComponentProps<typeof NativeChatMessageList>> = {}
  ): React.JSX.Element {
    return (
      <NativeChatMessageList
        session={sessionOf([prompt, ...rows])}
        journalItems={journal(rows)}
        isWorking
        expandSignal={false}
        {...props}
      />
    )
  }

  const liveLine = (): HTMLElement =>
    screen.getByText('Thinking').closest<HTMLElement>('[data-native-chat-turn-activity]')!

  describe('live reasoning, read through the one live line', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    it('shows one "Thinking", collapsed, and no row for the open block', () => {
      render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      expect(screen.getAllByText('Thinking')).toHaveLength(1)
      const toggle = screen.getByRole('button', { name: 'Thinking' })
      expect(toggle).toHaveAttribute('aria-expanded', 'false')
      expect(liveLine()).toContainElement(toggle)
      expect(screen.queryByRole('button', { name: /Reasoning|Thought/ })).toBeNull()
      expect(screen.queryByText('Weighing two approaches')).toBeNull()
    })

    it('opens to the live text, which follows the block as it grows', () => {
      const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
      rerender(list([reasoning('r-1', 'Weighing two approaches, then the cheaper one', 'running')]))
      expect(screen.getByText('Weighing two approaches, then the cheaper one')).toBeInTheDocument()
    })

    it('keeps the body out of the live region, which announces the label only', () => {
      render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      const body = screen.getByText('Weighing two approaches')
      expect(body.closest('[aria-live]')).toBeNull()
      expect(screen.getByText('Thinking').closest('[aria-live]')).not.toBeNull()
    })

    it('lands the finished row open when the reader opened it live, while the turn works on', () => {
      const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
      // The line no longer discloses anything; the row does, still open.
      expect(screen.queryByRole('button', { name: /Thinking|Working/ })).toBeNull()
      expect(screen.getByRole('button', { name: 'Reasoning: Thought for 12s' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
    })

    // The body owns its colour: inherited, it read full foreground under the line and muted in the row,
    // so the text dimmed as the block landed.
    it('draws the same body, in its own quieter tone, live and once landed', () => {
      const body = () =>
        screen.getByText('Weighing two approaches').closest('[data-native-chat-message-tone]')
      const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      const live = body()
      expect(live).toHaveAttribute('data-native-chat-message-tone', 'faint')
      expect(live).toHaveClass('text-chat-foreground-faint', 'pl-5.5', 'max-h-80')
      const liveClasses = live?.getAttribute('class')
      rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
      expect(body()?.getAttribute('class')).toBe(liveClasses)
    })

    it('starts the next block collapsed', () => {
      const { rerender } = render(list([reasoning('r-1', 'First thought', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      rerender(
        list([
          reasoning('r-1', 'First thought', 'completed'),
          reasoning('r-2', 'Second', 'running')
        ])
      )
      expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      expect(screen.queryByText('Second')).toBeNull()
    })

    it('is not expandable while the open block has no text yet', () => {
      render(list([reasoning('r-1', '', 'running')]))
      expect(screen.getAllByText('Thinking')).toHaveLength(1)
      expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull()
    })

    it('draws the open row when a waiting prompt replaces the line', () => {
      render(
        list([reasoning('r-1', 'Weighing two approaches', 'running')], {
          awaitingInput: 'unshown'
        })
      )
      expect(screen.queryByText('Thinking')).toBeNull()
      expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })

    // The open block can sit on a slot kept for its turn's bar or diff rollup; only the slot stays.
    it('draws no row for the open block under a diff rollup on its turn', () => {
      const edit: NativeChatMessage = {
        id: 'edit-1',
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'Diff', input: { path: 'a.ts' }, state: 'completed' },
          { type: 'tool-result', output: '@@ -1 +1 @@\n-old\n+new' }
        ],
        timestamp: STARTED,
        source: 'transcript'
      }
      render(
        list([
          edit,
          reasoning('r-1', 'Weighing two approaches', 'running', { timestamp: STARTED + 50 })
        ])
      )
      expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getAllByText('Weighing two approaches')).toHaveLength(1)
    })

    it('draws no row for the open block that carries a provider-opened turn bar', () => {
      const asked: NativeChatMessage = { ...prompt, id: 'u1', timestamp: 1 }
      const done: NativeChatMessage = {
        id: 'a1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Done.' }],
        timestamp: 2,
        source: 'transcript'
      }
      const woke = reasoning('r-w', 'Checking the background build', 'running', { timestamp: 3 })
      const thread = { kind: 'thread' as const }
      const inTurn = (turnItemId: string) => ({ kind: 'turn' as const, turnItemId })
      const item = (
        itemId: string,
        sequence: number,
        body: AgentJournalRenderItem['body'],
        turnScope: AgentJournalRenderItem['turnScope']
      ): AgentJournalRenderItem => ({
        itemId,
        revision: 0,
        sequence,
        observedAt: sequence,
        turnScope,
        body
      })
      const items = [
        item('u1', 1, { kind: 'message', role: 'user', blocks: asked.blocks }, thread),
        item('t1', 2, { kind: 'turn', turnId: 't1', state: 'completed', userItemId: 'u1' }, thread),
        item('a1', 3, { kind: 'message', role: 'assistant', blocks: done.blocks }, inTurn('t1')),
        item(
          'wake',
          4,
          { kind: 'turn', turnId: 'wake', state: 'running', userItemId: 'claude:wake' },
          thread
        ),
        item(
          'r-w',
          5,
          { kind: 'message', role: 'reasoning', blocks: woke.blocks, state: 'running' },
          inTurn('wake')
        )
      ]
      render(list([], { session: sessionOf([asked, done, woke]), journalItems: items }))
      expect(screen.getByText(/Working for/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getAllByText('Checking the background build')).toHaveLength(1)
    })

    // A live region only announces changes to itself; a replaced one says nothing.
    it('keeps one live region while the line turns into the disclosure and back', () => {
      const tool: NativeChatMessage = {
        id: 'tool-1',
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }
        ],
        timestamp: STARTED,
        source: 'transcript'
      }
      const later = { timestamp: STARTED + 50 }
      const region = () => document.querySelector('[data-native-chat-turn-activity][aria-live]')
      const { rerender } = render(list([tool]))
      const before = region()
      expect(before).toHaveTextContent('Working…')
      rerender(list([tool, reasoning('r-1', 'Weighing two approaches', 'running', later)]))
      expect(region()).toBe(before)
      expect(before).toHaveTextContent('Thinking')
      rerender(
        list([
          tool,
          reasoning('r-1', 'Weighing two approaches', 'completed', later),
          { ...tool, id: 'tool-2', timestamp: STARTED + 60 }
        ])
      )
      expect(region()).toBe(before)
      expect(before).toHaveTextContent('Working…')
    })
  })
}

{
  function frame(
    id: number,
    status: string,
    overrides: { kind?: string; truncated?: boolean } = {}
  ) {
    const kind = overrides.kind ?? 'notification:turn/plan/updated'
    const head = JSON.stringify({
      threadId: 'thread',
      turnId: 'turn',
      explanation: 'Keep verification visible',
      plan: [{ step: 'Verify', status }]
    })
    const body: AgentJournalStatusItem = {
      kind: 'status',
      text: `codex · ${kind}`,
      providerFrame: {
        provider: 'codex',
        kind,
        payload: {
          head,
          byteLength: new TextEncoder().encode(head).byteLength,
          digest: 'fixture-digest',
          truncated: overrides.truncated ?? false
        }
      }
    }
    const message = projectStructuredItemToNativeChat({
      itemId: `frame-${id}`,
      revision: 1,
      sequence: id,
      observedAt: id,
      body
    })
    if (!message) {
      throw new Error('Expected a projected message')
    }
    return message
  }

  function transcript(messages: NativeChatMessage[], sessionId = 'live-codex') {
    return (
      <NativeChatMessageList
        session={{
          messages,
          status: 'ready',
          sessionId,
          agent: 'codex',
          hasMore: false,
          loadingEarlier: false,
          olderHistoryGeneration: 0,
          loadEarlier: vi.fn(),
          readPhase: 'ready'
        }}
        isWorking={false}
        expandSignal
      />
    )
  }

  describe('live Codex checklist frames', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    it('updates one pinned checklist from journal notifications without rewinding on pagination', () => {
      const first = frame(1, 'pending')
      const active = frame(2, 'inProgress')
      const last = frame(3, 'completed')
      const { rerender, container } = render(transcript([first]))
      const toggle = screen.getByRole('button', { name: 'Tasks 0 of 1 tasks completed' })
      const viewport = container.querySelector('.overflow-y-auto')!
      expect(viewport.contains(toggle)).toBe(false)
      fireEvent.click(toggle)
      rerender(transcript([first, active]))
      expect(within(toggle.parentElement!).getByText('Verify').closest('li')).toHaveClass(
        'text-foreground'
      )
      expect(within(viewport as HTMLElement).getByText('Started Verify')).toBeInTheDocument()
      rerender(transcript([last]))
      expect(
        within(
          screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }).parentElement!
        ).getByText('Verify')
      ).toHaveClass('line-through')
      expect(screen.getAllByText('Keep verification visible')).toHaveLength(2)
      rerender(transcript([first, active, last]))
      expect(screen.getAllByText('Verify')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' })).toBe(toggle)
      expect(screen.getByText('Started Verify')).toBeInTheDocument()
      expect(screen.queryByText('notification:turn/plan/updated')).toBeNull()
      expect(projectNativeChatTaskListFrames([last])[0]).toBe(
        projectNativeChatTaskListFrames([last])[0]
      )
    })

    it('uses the latest complete snapshot across Codex tool calls and notifications', () => {
      const tool: NativeChatMessage = {
        id: 'tool',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        // Journalled like the frames it sits between.
        journalPosition: { sequence: 1, index: 0 },
        blocks: [
          {
            type: 'tool-call',
            name: 'update_plan',
            input: { plan: [{ step: 'Verify', status: 'pending' }] }
          }
        ]
      }
      render(transcript([tool, frame(3, 'completed')]))
      fireEvent.click(screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }))
      expect(screen.getAllByText('Verify')).toHaveLength(2)
      expect(
        within(
          screen.getByRole('button', { name: 'Tasks 1 of 1 tasks completed' }).parentElement!
        ).getByText('Verify')
      ).toHaveClass('line-through')
    })

    it('keeps malformed, truncated, other-provider, and plan-document frames unchanged', () => {
      const truncated = frame(1, 'pending', { truncated: true })
      const document = frame(2, 'pending', { kind: 'item:plan' })
      const malformed = frame(3, 'pending')
      const otherProvider = frame(4, 'pending')
      const malformedBlock = malformed.blocks[0]
      const otherBlock = otherProvider.blocks[0]
      if (malformedBlock.type === 'text' && malformedBlock.providerFrame) {
        malformedBlock.providerFrame.payload.head = '{"plan":null}'
      }
      if (otherBlock.type === 'text' && otherBlock.providerFrame) {
        otherBlock.providerFrame.provider = 'claude'
      }
      const messages = [truncated, document, malformed, otherProvider]
      const projected = projectNativeChatTaskListFrames(messages)
      projected.forEach((message, index) => expect(message).toBe(messages[index]))
      render(transcript([truncated]))
      // Unreadable as a list and wordless, so it is neither a checklist nor a raw row.
      expect(screen.queryByText('notification:turn/plan/updated')).toBeNull()
      expect(screen.queryByText('Tasks')).toBeNull()
    })

    // Stored for readers like the task list, drawn only when it has words of its own.
    it('hides a wordless unrecognised frame while a plan update still becomes the checklist', () => {
      const unknown = frame(1, 'pending', { kind: 'notification:future/event' })
      const failure = frame(2, 'pending', { kind: 'notification:future/failure' })
      const failureBlock = failure.blocks[0]
      if (failureBlock.type === 'text') {
        failureBlock.tone = 'error'
      }
      render(transcript([unknown, failure, frame(3, 'inProgress')]))
      expect(screen.queryByText('notification:future/event')).toBeNull()
      expect(screen.getByText('codex · notification:future/failure')).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Tasks 0 of 1 tasks completed' })
      ).toBeInTheDocument()
    })

    it('does not consume a neighboring tool failure as a notification result', () => {
      const command: NativeChatMessage = {
        id: 'command',
        role: 'assistant',
        timestamp: 2,
        source: 'transcript',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'verify' }, state: 'failed' },
          { type: 'tool-result', output: 'Verification failed', isError: true }
        ]
      }
      render(transcript([frame(1, 'pending'), command]))
      expect(
        screen.getByRole('button', { name: 'Tasks 0 of 1 tasks completed' })
      ).toBeInTheDocument()
      openToolRunMembers()
      expect(screen.getByText('Verification failed', { selector: 'pre' })).toHaveClass(
        'text-destructive'
      )
    })
  })

  describe('NativeChatMessageList task list history', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    it('keeps the latest Claude state after pagination and resets disclosure between sessions', () => {
      const first = {
        id: 'first-list',
        role: 'assistant' as const,
        timestamp: 1,
        source: 'transcript' as const,
        blocks: [
          {
            type: 'tool-call' as const,
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read', status: 'pending' },
                { content: 'Test', status: 'pending' }
              ]
            }
          }
        ]
      }
      const last = {
        ...first,
        id: 'last-list',
        timestamp: 3,
        blocks: [
          { type: 'text' as const, text: 'Ready for verification' },
          {
            type: 'tool-call' as const,
            name: 'TodoWrite',
            input: {
              todos: [
                { content: 'Read', status: 'completed' },
                { content: 'Test', status: 'pending' }
              ]
            }
          }
        ]
      }
      const { rerender } = render(transcript([last]))
      fireEvent.click(screen.getByRole('button', { name: 'Tasks 1 of 2 tasks completed' }))
      rerender(transcript([first, last]))
      expect(screen.getAllByText('Read')).toHaveLength(2)
      expect(screen.getByText('Completed Read')).toBeInTheDocument()
      expect(
        within(
          screen.getByRole('button', { name: 'Tasks 1 of 2 tasks completed' }).parentElement!
        ).getByText('Read')
      ).toHaveClass('line-through')
      expect(screen.getByText('Ready for verification')).toBeInTheDocument()
      rerender(transcript([first], 'two'))
      expect(screen.getByRole('button', { name: 'Tasks 0 of 2 tasks completed' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      expect(screen.getAllByText('Read')).toHaveLength(1)
      rerender(transcript([], 'three'))
      expect(screen.queryByText('Tasks')).toBeNull()
    })
  })
}

{
  const scrollTo = vi.fn()

  function item(
    itemId: string,
    body: AgentJournalItemBody,
    sequence: number
  ): AgentJournalRenderItem {
    return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1 }
  }
  const user = item(
    'user',
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Make the change' }] },
    1
  )
  const prose = item(
    'prose',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Updating the files.' }] },
    2
  )
  function diff(patch = '@@ -1 +1 @@\n-before\n+after'): AgentJournalRenderItem {
    return item(
      'diff',
      {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      3
    )
  }
  function session(items: AgentJournalRenderItem[]): NativeChatLiveSession {
    return {
      messages: projectStructuredQuestionMessages(items),
      status: 'ready',
      sessionId: 'session',
      agent: 'codex',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    }
  }
  function view(items: AgentJournalRenderItem[], structured = true) {
    return (
      <NativeChatMessageList
        session={session(items)}
        journalItems={structured ? items : undefined}
        isWorking={false}
        expandSignal={false}
      />
    )
  }

  describe('turn history presentation', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(() => {
      cleanup()
      vi.restoreAllMocks()
    })
    it('renders canonical pending questions while idle and keeps resolved answers at their row', () => {
      const question = item(
        'question',
        {
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'main' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        3
      )
      const { rerender } = render(view([user, prose, question]))
      expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
      expect(screen.getByText('Which branch?')).toBeInTheDocument()
      expect(screen.queryByText(/request_user_input/)).toBeNull()
      const settled = item(
        'question',
        {
          ...question.body,
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'main' }],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'main',
            resolvedBy: 'desktop',
            resolvedAt: 4000
          }
        },
        3
      )
      rerender(view([user, prose, settled]))
      expect(screen.queryByText('Awaiting user input:')).toBeNull()
      expect(screen.getByText('Asked:')).toBeInTheDocument()
      expect(screen.getByText('main')).toBeInTheDocument()
    })

    it('renders one resolved row when Claude journals both the call and receipt', () => {
      const call = item(
        'ask-call',
        {
          kind: 'tool-call',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which branch?' }] },
          state: 'completed',
          output: { head: 'main', byteLength: 4, truncated: false, digest: 'answer' }
        },
        3
      )
      const question = item(
        'question-receipt',
        {
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'main' }],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'main',
            resolvedBy: 'desktop',
            resolvedAt: 4000
          }
        },
        4
      )

      render(view([user, call, question]))

      expect(screen.getAllByText('Asked:')).toHaveLength(1)
      expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
    })

    it('groups pending Codex questions then narrows the awaiting count after one answer', () => {
      const first = item(
        'q1',
        {
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'main' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        3
      )
      const second = item(
        'q2',
        {
          kind: 'question',
          question: 'Proceed?',
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        4
      )
      const { rerender } = render(view([user, first, second]))
      expect(screen.getByText('2 questions')).toBeInTheDocument()
      expect(screen.getAllByText('Awaiting user input:')).toHaveLength(1)
      const answered = item(
        'q1',
        {
          kind: 'question',
          question: 'Which branch?',
          options: [{ id: 'main', label: 'main' }],
          resolution: {
            state: 'resolved',
            selectedOptionId: 'main',
            resolvedBy: 'phone',
            resolvedAt: 5000
          }
        },
        3
      )
      rerender(view([user, answered, second]))
      expect(screen.queryByText('2 questions')).toBeNull()
      expect(screen.getByText('Proceed?')).toBeInTheDocument()
      expect(screen.getByText('main')).toBeInTheDocument()
      expect(screen.getAllByText('Awaiting user input:')).toHaveLength(1)
    })

    it('reveals and scrolls to a folded diff card from a collapsed completed turn', () => {
      vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
      render(view([user, prose, diff()]))
      expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()
      const header = screen.getByRole('button', { name: /1 changed file/ })
      expect(header).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(header)
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      expect(screen.getByText('Edited')).toBeInTheDocument()
      expect(screen.getByText('after')).toBeInTheDocument()
      expect(screen.getByText('before')).toBeInTheDocument()
      expect(scrollTo).toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /Edited 1 file/ }))
      expect(screen.queryByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/ })).toBeNull()
      fireEvent.click(header)
      expect(header).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(header)
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      expect(scrollTo.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('updates journal revisions and replaces flat approval text with a passive receipt', () => {
      const approval = item(
        'approval',
        {
          kind: 'approval',
          title: 'Run tests?',
          detail: 'pnpm test',
          options: [{ id: 'allow', label: 'Allow once' }],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        4
      )
      const initial = [user, prose, diff(), approval]
      const { rerender } = render(view(initial))
      expect(screen.queryByText('Run tests?')).toBeNull()
      if (approval.body.kind !== 'approval') {
        throw new Error('fixture')
      }
      const resolved = {
        ...approval,
        revision: 2,
        body: {
          ...approval.body,
          resolution: {
            state: 'resolved' as const,
            selectedOptionId: 'allow',
            resolvedBy: 'desktop',
            resolvedAt: 5000
          }
        }
      }
      rerender(view([user, prose, diff('@@ -0,0 +1,2 @@\n+first\n+second'), resolved]))
      expect(screen.getByRole('button', { name: /1 changed file \+2/ })).toBeInTheDocument()
      expect(screen.getByText('Run tests?')).toBeInTheDocument()
      expect(screen.getByText('Allow once')).toBeInTheDocument()
      expect(screen.getByText('Answered on desktop')).toBeInTheDocument()
      expect(screen.getByText('Resolved').closest('[data-native-chat-receipt]')).not.toBeNull()
      expect(screen.queryByText('resolved')).toBeNull()
    })

    it('keeps rollups turn-local and leaves legacy message lists unchanged', () => {
      const secondUser = item(
        'user-two',
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Again' }] },
        5
      )
      const secondDiff = { ...diff(), itemId: 'second-diff', sequence: 6, observedAt: 6000 }
      const items = [user, prose, diff(), secondUser, secondDiff]
      const { rerender } = render(view(items))
      expect(screen.getAllByRole('button', { name: /1 changed file/ })).toHaveLength(2)
      rerender(view(items, false))
      expect(screen.queryByRole('button', { name: /changed file/ })).toBeNull()
    })
  })
}
