// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { render } from '../actions/native-chat-tooltip-test-harness'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from '../../viewport/virtualization/native-chat-message-list-test-viewport'
import { projectNativeChatTaskListFrames } from '../../../../../../shared/native-chat/input/native-chat-task-list-frames'

import { projectStructuredQuestionMessages } from '../../../../../../shared/structured-agent-question-projection'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'

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

  describe('live reasoning, read through the one live line', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)

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

    it('lands the finished row open when the reader opened it live, while the turn works on', () => {
      const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
      expect(screen.queryByRole('button', { name: /Thinking|Working/ })).toBeNull()
      expect(screen.getByRole('button', { name: 'Reasoning: Thought for 12s' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
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
      const toggle = screen.getByRole('button', { name: 'Tasks 0 of 1 task completed' })
      const viewport = container.querySelector('.overflow-y-auto')!
      expect(viewport.contains(toggle)).toBe(false)
      fireEvent.click(toggle)
      rerender(transcript([first, active]))
      expect(within(toggle.parentElement!).getByText('Verify').closest('li')).toHaveClass(
        'text-chat-foreground-strong'
      )
      expect(within(viewport as HTMLElement).getByText('Started Verify')).toBeInTheDocument()
      rerender(transcript([last]))
      expect(
        within(
          screen.getByRole('button', { name: 'Tasks 1 of 1 task completed' }).parentElement!
        ).getByText('Verify')
      ).toHaveClass('line-through')
      expect(screen.getAllByText('Keep verification visible')).toHaveLength(2)
      rerender(transcript([first, active, last]))
      expect(screen.getAllByText('Verify')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Tasks 1 of 1 task completed' })).toBe(toggle)
      expect(screen.getByText('Started Verify')).toBeInTheDocument()
      expect(screen.queryByText('notification:turn/plan/updated')).toBeNull()
      expect(projectNativeChatTaskListFrames([last])[0]).toBe(
        projectNativeChatTaskListFrames([last])[0]
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

    it('opens a recorded patch while completed work stays folded', () => {
      render(view([user, prose, diff()]))
      expect(screen.queryByText('after')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      expect(screen.getByText('after')).toBeInTheDocument()
      expect(screen.getByText('before')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Edited 1 file/, expanded: false })).toBeVisible()
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
      expect(screen.getByRole('button', { name: /src\/a.ts \+2/ })).toBeInTheDocument()
      expect(screen.getByText('Run tests?')).toBeInTheDocument()
      expect(screen.getByText('Allow once')).toBeInTheDocument()
      expect(screen.getByText('Answered on another device')).toBeInTheDocument()
      expect(screen.getByText('Resolved').closest('[data-native-chat-receipt]')).not.toBeNull()
      expect(screen.queryByText('resolved')).toBeNull()
    })
  })
}
