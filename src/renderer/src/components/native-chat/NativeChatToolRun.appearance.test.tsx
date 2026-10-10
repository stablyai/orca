// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NativeChatBlock } from '../../../../shared/native-chat-types'

import { NativeChatToolRun } from './NativeChatToolRun'

import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'

import { revealNativeChatToolRunMember } from './NativeChatToolRunMembers'

import { i18n } from '@/i18n/i18n'

{
  const blocks: NativeChatBlock[] = [
    { type: 'tool-call', name: 'Bash', input: { command: 'test' }, state: 'failed' },
    { type: 'tool-result', output: 'exit 1', isError: true },
    { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
    { type: 'tool-call', name: 'Write', input: { file_path: 'a.ts' }, state: 'completed' },
    { type: 'tool-call', name: 'Grep', input: { pattern: 'todo' }, state: 'completed' },
    { type: 'tool-call', name: 'Task', input: { description: 'Review' }, state: 'completed' }
  ]

  describe('tool-run summary in a matching chat', () => {
    afterEach(cleanup)
    it.each([false, true])('caps the summary at two wrapped lines, live=%s', (live) => {
      const style = nativeChatAppearanceStyle({
        terminalFontFamily: 'Menlo',
        nativeChatAppearance: { matchTerminalInterface: true }
      })
      const { container } = render(
        <div className="native-chat-appearance" style={style}>
          <div className="max-w-(--chat-content-max-width)">
            <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={live} />
          </div>
        </div>
      )
      expect(style['--chat-content-max-width']).toBe('46rem')
      expect(style['--chat-font-family']).toContain('Menlo')
      const summary = container.querySelector('span.native-chat-message-text')
      expect(summary).toHaveTextContent(live ? 'running 1 agent' : 'ran 1 agent')
      expect(summary).toHaveClass('min-w-0', 'line-clamp-2', 'whitespace-normal', 'break-words')
      expect(summary).not.toHaveClass('truncate', 'whitespace-nowrap', 'font-mono')
      const failure = container.querySelector('[aria-label="Failed tool calls: 1"]')
      expect(failure).toHaveTextContent('1 failed')
      expect(failure).toHaveClass('shrink-0')
      expect(failure?.parentElement).toHaveClass('flex', 'h-[1lh]', 'items-center')
    })

    it('keeps a long command available in the expanded detail', () => {
      const command = `printf ${'x'.repeat(5000)}`
      const style = nativeChatAppearanceStyle({
        terminalFontFamily: 'Menlo',
        nativeChatAppearance: { matchTerminalInterface: true }
      })
      const { container } = render(
        <div className="native-chat-appearance" style={style}>
          <NativeChatToolRun
            blocks={[{ type: 'tool-call', name: 'shell', input: { command }, state: 'completed' }]}
            expandSignal={false}
          />
        </div>
      )

      const summary = container.querySelector('span.native-chat-message-text')
      expect(summary).toHaveClass('line-clamp-2', 'break-words')
      expect(summary?.textContent).toContain('printf')
      expect(summary?.textContent?.length).toBeLessThan(command.length)
      expect(container.querySelector('pre')).toBeNull()

      fireEvent.click(screen.getByRole('button'))
      openToolRunMembers()

      expect(container.querySelector('pre')).toHaveTextContent(command)
    })

    it.each([
      ['wrapped', `QA inert command for display only: ${'x'.repeat(400)}`],
      ['single-line', 'pnpm test']
    ])('pins the marks to the first line of a %s summary', (_summaryLength, command) => {
      const { container } = render(
        <NativeChatToolRun
          blocks={[
            { type: 'tool-call', name: 'shell', input: { command }, state: 'completed' },
            { type: 'tool-result', output: 'done' }
          ]}
          expandSignal={false}
          activeTurnIsWorking={false}
        />
      )

      const header = screen.getByRole('button')
      // Top-aligned in the summary's own type, so `1lh` is one summary line.
      expect(header).toHaveClass('items-start', 'text-sm', 'leading-relaxed')
      expect(header).toHaveClass('native-chat-message-text')
      expect(header).not.toHaveClass('items-center')
      const summary = container.querySelector('span.native-chat-message-text')
      expect(summary?.parentElement).toBe(header)
      expect(summary).toHaveClass('min-w-0', 'line-clamp-2')

      const slots = Array.from(header.children).filter((child) => child !== summary)
      expect(slots.length).toBeGreaterThanOrEqual(2)
      for (const slot of slots) {
        expect(slot).toHaveClass('flex', 'h-[1lh]', 'items-center')
      }
      // The icon leads, so a wrapped second line starts under the text, not under it.
      expect(header.firstElementChild?.querySelector('svg')).toBeInTheDocument()
      expect(header.children[1]).toBe(summary)
      expect(header.querySelector('.lucide-check')?.parentElement).toHaveClass('h-[1lh]')
      // The header carries no caret: the whole line is the toggle.
      expect(header.querySelector('.lucide-chevron-right')).toBeNull()
    })
  })
}

{
  const QUESTION = 'What would you like me to do next in this repo?'
  const ASK_INPUT = { questions: [{ question: QUESTION }] }

  function askBlocks(state: 'running' | 'completed'): NativeChatBlock[] {
    return [{ type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state }]
  }

  /** Lays every element out wider than its box, as a long question is on its line. */
  function clipEveryLine(): () => void {
    const originals = ['scrollWidth', 'clientWidth'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 400
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 100
    })
    return () => {
      for (const [name, original] of originals) {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, name, original)
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, name)
        }
      }
    }
  }

  function DisclosureHarness({ mounted }: { mounted: boolean }): React.JSX.Element {
    const disclosures = useNativeChatDisclosures()
    return (
      <NativeChatDisclosureContext.Provider value={disclosures}>
        {mounted ? (
          <NativeChatToolRun
            blocks={askBlocks('completed')}
            expandSignal
            activeTurnIsWorking={false}
            disclosureId="message-1"
          />
        ) : null}
      </NativeChatDisclosureContext.Provider>
    )
  }

  describe('NativeChatToolRun awaiting-input row', () => {
    afterEach(cleanup)
    it('does not revive stale tool state after a turn stops', () => {
      render(
        <NativeChatToolRun blocks={askBlocks('running')} expandSignal activeTurnIsWorking={false} />
      )
      expect(screen.queryByText('Awaiting user input:')).toBeNull()
      expect(screen.getByText('Asked:')).toBeInTheDocument()
    })

    it('keeps a pending question visible alongside another active tool', () => {
      render(
        <NativeChatToolRun
          blocks={[
            ...askBlocks('running'),
            { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'running' }
          ]}
          expandSignal
          activeTurnIsWorking
        />
      )
      expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
      expect(screen.getByText('Reading 1 file')).toBeInTheDocument()
      expect(screen.getByText('Read a.ts')).toBeInTheDocument()
    })

    it('preserves errors from failed question calls', () => {
      render(
        <NativeChatToolRun
          blocks={[
            { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'failed' },
            { type: 'tool-result', output: 'Question rejected', isError: true }
          ]}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      openToolRunMembers()
      expect(screen.queryByText('Awaiting user input:')).toBeNull()
      expect(screen.queryByText('Asked:')).toBeNull()
      expect(screen.getAllByText('Question rejected').length).toBeGreaterThan(0)
    })
    it('replaces a running ask call with the awaiting row', () => {
      const { container } = render(
        <NativeChatToolRun blocks={askBlocks('running')} expandSignal activeTurnIsWorking />
      )

      expect(screen.getByText('Awaiting user input:')).toHaveClass(
        'animate-pulse',
        'motion-reduce:animate-none'
      )
      expect(screen.getByText(QUESTION)).toBeInTheDocument()
      expect(container.querySelector('.lucide-message-square-more')).toBeInTheDocument()
      // The raw call and its payload are exactly what this row exists to replace.
      expect(screen.queryByText(/Running AskUserQuestion/)).toBeNull()
      expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
    })

    it('reports a settled ask without the pulse or a tool-count header', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={askBlocks('completed')}
          expandSignal
          activeTurnIsWorking={false}
        />
      )

      expect(screen.getByText('Asked:')).not.toHaveClass('animate-pulse')
      expect(screen.getByText(QUESTION)).toBeInTheDocument()
      // A run that is only the ask has no work left to head, so it draws no header.
      expect(container.querySelector('[data-native-chat-tool-run-state]')).toBeNull()
    })

    it('leaves a question that fits on its line as plain text', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={askBlocks('completed')}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      expect(screen.getByText(QUESTION)).toHaveClass('truncate')
      expect(container.querySelector('button')).toBeNull()
    })

    it('opens a clipped question below the toggle and folds it back', () => {
      const restore = clipEveryLine()
      try {
        render(
          <NativeChatToolRun
            blocks={askBlocks('completed')}
            expandSignal
            activeTurnIsWorking={false}
          />
        )
        const toggle = screen.getByRole('button', { name: /Asked:/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        const full = screen.getByText(QUESTION)
        expect(full).not.toHaveClass('truncate')
        // Outside the button, so it selects like prose and a click in it keeps it open.
        expect(full.closest('button')).toBeNull()
        fireEvent.click(full)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')

        fireEvent.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByText(QUESTION)).toHaveClass('truncate')
      } finally {
        restore()
      }
    })

    it('keeps an opened question open when the windowed row remounts', () => {
      const restore = clipEveryLine()
      try {
        const { rerender } = render(<DisclosureHarness mounted />)
        fireEvent.click(screen.getByRole('button', { name: /Asked:/ }))

        rerender(<DisclosureHarness mounted={false} />)
        expect(screen.queryByText(QUESTION)).toBeNull()
        rerender(<DisclosureHarness mounted />)

        const toggle = screen.getByRole('button', { name: /Asked:/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(QUESTION).closest('button')).toBeNull()

        // Folding it keeps the same control, so keyboard focus is not dropped.
        toggle.focus()
        fireEvent.click(toggle)
        expect(document.activeElement).toBe(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
      } finally {
        restore()
      }
    })

    it('offers no expansion when the row names only a question count', () => {
      const restore = clipEveryLine()
      try {
        const input = { questions: [{ question: 'First?' }, { question: 'Second?' }] }
        render(
          <NativeChatToolRun
            blocks={[{ type: 'tool-call', name: 'AskUserQuestion', input, state: 'completed' }]}
            expandSignal
            activeTurnIsWorking={false}
          />
        )
        expect(screen.getByText('2 questions')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Asked:/ })).toBeNull()
      } finally {
        restore()
      }
    })

    it('counts only the work that ran in the header beside the ask', () => {
      const blocks: NativeChatBlock[] = [
        { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
        { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'running' }
      ]

      render(<NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking />)

      expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
      // One call ran; being asked a question is not work to summarize. The agent
      // is blocked on the reader, so the run reads settled, not in progress.
      expect(screen.getByText('Read 1 file')).toBeInTheDocument()
      expect(screen.queryByText('Reading 1 file')).toBeNull()
    })

    it('draws the row from the tool name when the payload names no question', () => {
      render(
        <NativeChatToolRun
          blocks={[{ type: 'tool-call', name: 'request_user_input', input: {}, state: 'running' }]}
          expandSignal
          activeTurnIsWorking
        />
      )

      expect(screen.getByText('Awaiting user input')).toBeInTheDocument()
      expect(screen.queryByText(/request_user_input/)).toBeNull()
    })
  })
}

{
  const VIEWPORT = 200

  function calls(count: number): NativeChatBlock[] {
    return Array.from({ length: count }, (_, index) => ({
      type: 'tool-call' as const,
      name: 'Read',
      callId: `call-${index}`,
      input: `{"file_path":"src/file-${index}.ts"}`
    }))
  }

  /** happy-dom lays nothing out, so the box's geometry is whatever the test says it is. */
  function layOut(contentHeight: { current: number }): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => contentHeight.current
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  }

  function membersBox(container: HTMLElement): HTMLElement {
    const box = container.querySelector<HTMLElement>('[data-native-chat-tool-run-members]')
    if (!box) {
      throw new Error('members box did not render')
    }
    return box
  }

  /** A live run inside the transcript's disclosure store, which is what remembers its box. */
  function Transcript({
    mounted = true,
    count = 3
  }: {
    mounted?: boolean
    count?: number
  }): React.JSX.Element {
    const disclosures = useNativeChatDisclosures()
    return (
      <NativeChatDisclosureContext.Provider value={disclosures}>
        {mounted ? (
          <NativeChatToolRun
            blocks={calls(count)}
            expandSignal
            activeTurnIsWorking
            disclosureId="message-1"
          />
        ) : null}
      </NativeChatDisclosureContext.Provider>
    )
  }

  describe('NativeChatToolRun members box', () => {
    afterEach(() => {
      cleanup()
      vi.restoreAllMocks()
    })
    it('keeps a live run on its newest call until the reader scrolls away', () => {
      const contentHeight = { current: 600 }
      layOut(contentHeight)
      const run = (count: number): React.JSX.Element => (
        <NativeChatToolRun blocks={calls(count)} expandSignal activeTurnIsWorking />
      )
      const { container, rerender } = render(run(3))
      const box = membersBox(container)
      expect(box.scrollTop).toBe(600)

      contentHeight.current = 900
      rerender(run(4))
      expect(box.scrollTop).toBe(900)

      box.scrollTop = 100
      fireEvent.scroll(box)
      contentHeight.current = 1200
      rerender(run(5))
      expect(box.scrollTop).toBe(100)

      box.scrollTop = 1200 - VIEWPORT
      fireEvent.scroll(box)
      contentHeight.current = 1500
      rerender(run(6))
      expect(box.scrollTop).toBe(1500)
    })

    it('comes back where the reader left it after windowing unmounts the row', () => {
      const contentHeight = { current: 900 }
      layOut(contentHeight)
      const { container, rerender } = render(<Transcript mounted count={3} />)
      const box = membersBox(container)
      box.scrollTop = 100
      fireEvent.scroll(box)

      rerender(<Transcript mounted={false} count={3} />)
      contentHeight.current = 1200
      rerender(<Transcript mounted count={4} />)

      // Neither back at the newest call nor following again: both were the reader's choice.
      expect(membersBox(container).scrollTop).toBe(100)
    })

    it('forgets its place when the reader closes it', () => {
      layOut({ current: 900 })
      const { container } = render(<Transcript />)
      const box = membersBox(container)
      box.scrollTop = 100
      fireEvent.scroll(box)

      const header = container.querySelector<HTMLElement>('[data-native-chat-tool-run-state]')!
      fireEvent.click(header)
      fireEvent.click(header)

      // A live run the reader reopens shows what it is doing now.
      expect(membersBox(container).scrollTop).toBe(900)
    })

    it('opens a settled run at its first call', () => {
      layOut({ current: 600 })
      const { container } = render(
        <NativeChatToolRun blocks={calls(3)} expandSignal activeTurnIsWorking={false} />
      )
      expect(membersBox(container).scrollTop).toBe(0)
    })

    it('brings a revealed member to the top of the box and reports the box', () => {
      layOut({ current: 600 })
      const { container } = render(
        <NativeChatToolRun blocks={calls(3)} expandSignal activeTurnIsWorking={false} />
      )
      const box = membersBox(container)
      const member = box.querySelectorAll('button')[2]!
      vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 300, VIEWPORT))
      vi.spyOn(member, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 340, 300, 26))

      expect(revealNativeChatToolRunMember(member)).toBe(box)
      expect(box.scrollTop).toBe(300)
    })
  })

  describe('NativeChatToolRun asides', () => {
    afterEach(() => {
      cleanup()
      vi.restoreAllMocks()
    })
    it('draws the rows it is handed among its calls, in order', () => {
      const blocks = calls(2)
      const { container } = render(
        <NativeChatToolRun
          blocks={blocks}
          asides={{
            before: new Map([[blocks[1]!, [<p key="between">between</p>]]]),
            after: [<p key="last">last</p>]
          }}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      const rows = [...membersBox(container).querySelectorAll('button, p')].map(
        (row) => row.textContent ?? ''
      )
      expect(rows).toHaveLength(4)
      expect(rows[0]).toContain('file-0.ts')
      expect(rows[1]).toBe('between')
      expect(rows[2]).toContain('file-1.ts')
      expect(rows[3]).toBe('last')
    })
  })
}

{
  function runHeader(container: HTMLElement): HTMLElement {
    const header = container.querySelector('button')
    if (!header) {
      throw new Error('run header did not render')
    }
    return header
  }

  describe('tool run sentences', () => {
    afterEach(async () => {
      cleanup()
      await i18n.changeLanguage('en')
    })
    it.each(['Task', 'Agent'])('separates failure counts in command and %s runs', (name) => {
      const blocks: NativeChatBlock[] = [
        { type: 'tool-call', name: 'Bash', input: { command: 'false' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 1', isError: true },
        {
          type: 'tool-call',
          name,
          input: { description: 'explored settings search entries' },
          state: 'completed'
        }
      ]
      const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)
      const header = runHeader(container)
      expect(header).toHaveTextContent('Ran 1 command and ran 1 agent · 1 failed')
      expect(header).toHaveAccessibleName(/Failed tool calls: 1/)
      expect(header).not.toHaveAccessibleName(/·/)
      fireEvent.click(header)
      expect(screen.getByText('Subagent')).toBeInTheDocument()
      expect(screen.getByTitle('explored settings search entries')).toBeInTheDocument()
    })

    it('uses the agent glyph for a lone Agent transcript call', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={[
            {
              type: 'tool-call',
              name: 'Agent',
              input: { description: 'inspect settings' },
              state: 'completed'
            }
          ]}
          expandSignal
        />
      )
      expect(runHeader(container)).toHaveTextContent('Ran 1 agent')
      expect(container.querySelectorAll('button .lucide-bot')).toHaveLength(2)
    })

    it('relabels an already-mounted run and its rows when the UI language changes', async () => {
      const blocks: NativeChatBlock[] = [
        { type: 'tool-call', name: 'Bash', input: { command: 'false' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 1', isError: true },
        {
          type: 'tool-call',
          name: 'Agent',
          input: { description: 'explore settings' },
          state: 'completed'
        }
      ]
      const { container } = render(
        <NativeChatToolRun
          blocks={blocks}
          backgroundTasks={[
            {
              type: 'background-task',
              taskId: 'workflow-1',
              kind: 'workflow',
              label: 'task',
              state: 'blocked',
              outputFile: '/tmp/result.txt'
            }
          ]}
          expandSignal
        />
      )
      const header = runHeader(container)
      expect(header).toHaveTextContent('Ran 1 command and ran 1 agent · 1 failed')
      expect(screen.getByText('Subagent')).toBeInTheDocument()
      expect(screen.getByText('Background workflow')).toBeInTheDocument()
      expect(screen.getByText('Output: /tmp/result.txt')).toBeInTheDocument()

      await act(async () => {
        await i18n.changeLanguage('es')
      })

      expect(header).toHaveTextContent('Se ejecutó 1 comando y se ejecutó 1 agente · 1 fallidas')
      expect(header).toHaveAccessibleName(/Llamadas a herramientas fallidas: 1/)
      expect(screen.getByText('Subagente')).toBeInTheDocument()
      expect(screen.getByText('Flujo de trabajo en segundo plano')).toBeInTheDocument()
      expect(screen.getByText('Salida: /tmp/result.txt')).toBeInTheDocument()
      expect(screen.getByText('bloqueado · con error')).toBeInTheDocument()
    })
  })
}
