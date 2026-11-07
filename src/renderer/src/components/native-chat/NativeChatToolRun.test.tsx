// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { NativeChatToolRun } from './NativeChatToolRun'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

afterEach(cleanup)

/** Read lucide classes so identity-changing glyph swaps remain observable. */

/** The first button is the header; summary members render as separate pills. */
function runHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('button')
  if (!header) {
    throw new Error('run header did not render')
  }
  return header
}

describe('NativeChatToolRun', () => {
  it('renders evidence-shaped projected patches as colored diffs without changes JSON', () => {
    const item: AgentJournalRenderItem = {
      itemId: 'apply-patch',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'apply_patch',
        input: {
          changes: [
            {
              path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-before\n+after'
            }
          ]
        },
        state: 'completed'
      }
    }
    const projected = projectStructuredItemToNativeChat(item)

    expect(projected).not.toBeNull()
    const { container } = render(
      <NativeChatToolRun blocks={projected?.blocks ?? []} expandSignal />
    )
    openToolRunMembers()

    expect(screen.getByText('after').closest('div')).toHaveClass(
      'bg-[var(--diff-added-background)]'
    )
    expect(screen.getByText('before').closest('div')).toHaveClass(
      'bg-[var(--diff-removed-background)]'
    )
    expect(container).not.toHaveTextContent('"changes"')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps the provider error visible for an edit the agent could not apply', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Edit',
        input: { file_path: '/repo/a.ts', old_string: 'missing', new_string: 'now' }
      },
      { type: 'tool-result', output: 'String to replace not found in file.', isError: true }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)
    openToolRunMembers()

    const editRow = screen.getByRole('button', { name: /^Edit Tried to edit \/repo\/a\.ts/ })
    expect(within(editRow).queryByText('Edited')).toBeNull()
    const body = [...container.querySelectorAll('pre')].find(
      (pre) => pre.textContent === 'String to replace not found in file.'
    )
    expect(body).toHaveTextContent('String to replace not found in file.')
    expect(body).toHaveClass('text-destructive')
  })

  it('copies the diff as signed rows, with the region breaks left out', () => {
    const writeClipboardText = vi.fn()
    Object.assign(window, { api: { ui: { writeClipboardText } } })
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Edit',
        input: { file_path: '/repo/a.ts' },
        state: 'completed'
      },
      {
        type: 'tool-result',
        output: 'ok',
        editPatch: {
          filePath: '/repo/a.ts',
          hunks: [
            { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' ctx', '-was', '+now'] },
            { oldStart: 90, oldLines: 1, newStart: 90, newLines: 1, lines: ['+tail'] }
          ]
        }
      }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy diff' }))

    expect(writeClipboardText).toHaveBeenCalledWith(' ctx\n-was\n+now\n+tail')
  })

  // Call transitions must preserve one turn-owned header, its count, hover and status mark.
  it('keeps one header element from a call starting until its turn ends', () => {
    const running: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }
    ]
    const settled: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'completed' },
      { type: 'tool-result', output: 'done' }
    ]
    const { rerender, container } = render(
      <NativeChatToolRun blocks={running} expandSignal={false} activeTurnIsWorking />
    )
    const header = runHeader(container)
    expect(header).toHaveAttribute('data-native-chat-tool-run-state', 'live')
    expect(header).toHaveTextContent('Running 1 command')
    expect(header).toHaveTextContent('sleep 1')

    rerender(<NativeChatToolRun blocks={settled} expandSignal={false} activeTurnIsWorking />)
    expect(runHeader(container)).toBe(header)
    expect(header).toHaveAttribute('data-native-chat-tool-run-state', 'live')
    expect(header).toHaveTextContent('Running 1 command')
    expect(header.querySelector('.lucide-check')).toBeNull()

    const next: NativeChatBlock[] = [
      ...settled,
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 2' }, state: 'running' }
    ]
    rerender(<NativeChatToolRun blocks={next} expandSignal={false} activeTurnIsWorking />)
    expect(runHeader(container)).toBe(header)
    expect(header).toHaveTextContent('Running 2 commands')
    expect(header).toHaveTextContent('sleep 2')

    const done: NativeChatBlock[] = [
      ...settled,
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 2' }, state: 'completed' },
      { type: 'tool-result', output: 'done' }
    ]
    rerender(<NativeChatToolRun blocks={done} expandSignal={false} activeTurnIsWorking={false} />)
    expect(runHeader(container)).toBe(header)
    expect(header).toHaveAttribute('data-native-chat-tool-run-state', 'settled')
    expect(header).toHaveTextContent('Ran 2 commands')
    expect(header).not.toHaveTextContent('Running')
    expect(header.querySelector('.lucide-check')).toBeInTheDocument()
    expect(header.querySelector('.animate-pulse')).toBeNull()
  })

  it('keeps a post-turn running call neutral until the item itself settles', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }
    ]

    const { container, rerender } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />
    )

    expect(screen.queryByText('Running sleep 1')).toBeNull()
    expect(container.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
    rerender(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'completed' }
        ]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )
    expect(container.querySelector('.lucide-check')).toBeInTheDocument()
  })

  // Unnamed group-hover matches the surrounding message too, revealing every member caret at once.
})

describe('NativeChatToolRun task lists', () => {
  it('renders task updates instead of JSON and consumes successful results', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'update_plan',
        input: {
          plan: [
            { step: 'Read', status: 'in_progress' },
            { step: 'Test', status: 'pending' }
          ]
        }
      },
      { type: 'tool-result', output: 'Plan updated' },
      {
        type: 'tool-call',
        name: 'update_plan',
        input: {
          plan: [
            { step: 'Read', status: 'completed' },
            { step: 'Test', status: 'in_progress' }
          ]
        }
      }
    ]
    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)
    expect(screen.getByText('Completed Read')).toBeInTheDocument()
    expect(screen.getByText('Started Test')).toBeInTheDocument()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.queryByText('Plan updated')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps malformed calls and failed results visible in the generic view', () => {
    render(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'TodoWrite', input: '{' },
          { type: 'tool-result', output: 'Invalid arguments', isError: true },
          {
            type: 'tool-call',
            name: 'TodoWrite',
            input: { todos: [{ content: 'Test', status: 'completed' }] }
          },
          { type: 'tool-result', output: 'Update rejected', isError: true }
        ]}
        expandSignal
      />
    )
    openToolRunMembers()
    expect(screen.getByText('Invalid arguments', { selector: 'pre' })).toBeInTheDocument()
    expect(screen.getByText('Update rejected', { selector: 'pre' })).toBeInTheDocument()
    expect(screen.queryByText('1/1')).toBeNull()
  })
})
