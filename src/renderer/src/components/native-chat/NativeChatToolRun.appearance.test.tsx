// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

afterEach(cleanup)

const blocks: NativeChatBlock[] = [
  { type: 'tool-call', name: 'Bash', input: { command: 'test' }, state: 'failed' },
  { type: 'tool-result', output: 'exit 1', isError: true },
  { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
  { type: 'tool-call', name: 'Write', input: { file_path: 'a.ts' }, state: 'completed' },
  { type: 'tool-call', name: 'Grep', input: { pattern: 'todo' }, state: 'completed' },
  { type: 'tool-call', name: 'Task', input: { description: 'Review' }, state: 'completed' }
]

describe('tool-run summary in a matching chat', () => {
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
    expect(slots.length).toBeGreaterThanOrEqual(3)
    for (const slot of slots) {
      expect(slot).toHaveClass('flex', 'h-[1lh]', 'items-center')
    }
    // The icon leads, so a wrapped second line starts under the text, not under it.
    expect(header.firstElementChild?.querySelector('svg')).toBeInTheDocument()
    expect(header.children[1]).toBe(summary)
    expect(header.querySelector('.lucide-check')?.parentElement).toHaveClass('h-[1lh]')
    expect(header.querySelector('.lucide-chevron-right')?.parentElement).toHaveClass('h-[1lh]')
  })
})
