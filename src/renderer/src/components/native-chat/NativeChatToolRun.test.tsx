// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatToolRun } from './NativeChatToolRun'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

afterEach(cleanup)

/** Read lucide classes so identity-changing glyph swaps remain observable. */
function leadingGlyphs(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('button')].map(
    (button) =>
      button
        .querySelector('svg')
        ?.getAttribute('class')
        ?.match(/lucide-[a-z0-9-]+/)?.[0] ?? null
  )
}

/** The first button is the header; summary members render as separate pills. */
function runHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('button')
  if (!header) {
    throw new Error('run header did not render')
  }
  return header
}

describe('NativeChatToolRun', () => {
  it('uses the shared clean label for a desktop tool row', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Read',
        input: '{"file_path":"src/index.ts","offset":10}'
      }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(screen.getByTitle('src/index.ts')).toHaveTextContent('index.ts')
    expect(screen.queryByTitle('{"file_path":"src/index.ts","offset":10}')).toBeNull()
  })

  it('renders structured apply_patch changes as a reviewable diff instead of JSON', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'apply_patch',
        // This lane carries its patch on the call; provider completion proves the edit landed.
        state: 'completed',
        input: {
          changes: [
            {
              path: '/repo/src/app.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-before\n+after'
            }
          ]
        }
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)
    openToolRunMembers()

    expect(screen.getByText('after')).toBeInTheDocument()
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.getByText('Edited')).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
  })

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

    expect(screen.getByText('after').closest('div')).toHaveClass('bg-[var(--diff-added-ground)]')
    expect(screen.getByText('before').closest('div')).toHaveClass('bg-[var(--diff-removed-ground)]')
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
    const body = container.querySelector('pre')
    expect(body).toHaveTextContent('String to replace not found in file.')
    expect(body).toHaveClass('text-destructive')
  })

  it('leaves a `git diff` command as a command row rather than an edit card', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'exec', input: { command: 'git diff' }, state: 'completed' },
      {
        type: 'tool-result',
        output: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-was\n+now'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const commandRow = screen.getByRole('button', { name: /^exec Ran git diff/ })
    expect(within(commandRow).queryByText('Edited')).toBeNull()
    expect(container).toHaveTextContent('git diff')
  })

  it('shows no gutter number for a snippet edit, which cannot locate itself', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Edit',
        input: { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' },
        state: 'completed'
      },
      { type: 'tool-result', output: 'ok' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)
    openToolRunMembers()

    // Exact, because a snippet-relative number would sit ahead of the marker.
    expect(screen.getByText('now').closest('div')?.textContent).toBe('+now')
    expect(screen.getByText('was').closest('div')?.textContent).toBe('-was')
  })

  it('separates two regions of a file so the gutter jump is accounted for', () => {
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
            { oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, lines: ['-was', '+now'] },
            { oldStart: 310, oldLines: 1, newStart: 310, newLines: 1, lines: ['-old', '+new'] }
          ]
        }
      }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)
    openToolRunMembers()

    const separators = screen.getAllByRole('separator')
    expect(separators).toHaveLength(1)
    expect(separators[0]).toHaveAccessibleName('Lines not shown')
  })

  it('offers no empty body for a delete, which names the file and nothing else', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'apply_patch',
        input: { input: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch' },
        state: 'completed'
      }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(screen.getByTitle('gone.ts')).toBeInTheDocument()
    expect(screen.getByText('Deleted').closest('button')).not.toHaveAttribute('aria-expanded')
  })

  it('says a diff was clipped even while the card is collapsed', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Diff',
        input: { path: 'src/a.ts' },
        state: 'completed'
      },
      { type: 'tool-result', output: '@@ -1,3 +1,3 @@\n ctx\n-was\n+now\n… (48210 bytes)' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(screen.getByText('Diff truncated')).toBeInTheDocument()
    expect(screen.queryByText('was')).toBeNull()
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

  describe('reading a batch as a group', () => {
    const batch: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'mcp__linear__list_issues',
        input: { query: 'todo' },
        state: 'completed',
        mcpIdentity: { server: 'linear', tool: 'list_issues' }
      },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls -la' }, state: 'completed' },
      { type: 'tool-call', name: 'read', input: { file_path: 'README.md' }, state: 'completed' }
    ]

    // Summarize categories; separators also occur inside tool names and make joined call lists ambiguous.
    it('summarizes a run by category, in the order the run first used each one', () => {
      const { container } = render(<NativeChatToolRun blocks={batch} expandSignal={false} />)

      expect(runHeader(container)).toHaveTextContent(
        'Used 1 integration, ran 1 command, and read 1 file'
      )
    })

    it('names no individual call in the header, however wide the run', () => {
      const { container } = render(<NativeChatToolRun blocks={batch} expandSignal={false} />)

      const header = runHeader(container)
      expect(header).not.toHaveTextContent('mcp__linear__list_issues')
      expect(header).not.toHaveTextContent('ls -la')
      expect(header).not.toHaveTextContent('README.md')
    })

    it('counts every call rather than capping the list and marking a remainder', () => {
      const wide: NativeChatBlock[] = [
        ...batch,
        { type: 'tool-call', name: 'Grep', input: { pattern: 'todo' }, state: 'completed' },
        { type: 'tool-call', name: 'Write', input: { file_path: 'a.ts' }, state: 'completed' }
      ]

      const { container } = render(<NativeChatToolRun blocks={wide} expandSignal={false} />)

      expect(runHeader(container)).not.toHaveTextContent('more')
      expect(runHeader(container)).toHaveTextContent(
        'Used 1 integration, ran 1 command, read 1 file, searched 1 time, and edited 1 file'
      )
    })

    it('joins exactly two categories with "and", and no comma', () => {
      const pair: NativeChatBlock[] = [
        { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'completed' },
        { type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'completed' },
        { type: 'tool-call', name: 'read', input: { file_path: 'a.ts' }, state: 'completed' }
      ]

      const { container } = render(<NativeChatToolRun blocks={pair} expandSignal={false} />)

      expect(runHeader(container)).toHaveTextContent('Ran 2 commands and read 1 file')
    })

    it('prints the split MCP name on the opened row', () => {
      render(<NativeChatToolRun blocks={batch} expandSignal />)

      expect(screen.getByText('Linear')).toBeInTheDocument()
    })

    it('gives a run whose tool it cannot name the generic category', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={[{ type: 'tool-call', name: '   ', input: {}, state: 'completed' }]}
          expandSignal={false}
        />
      )

      expect(runHeader(container)).toHaveTextContent('Used 1 tool')
    })

    it('keeps a lone command as the header, unwrapped from its login shell', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={[
            {
              type: 'tool-call',
              name: 'shell',
              input: { command: `/bin/zsh -lc 'git push --force-with-lease'` },
              state: 'completed'
            }
          ]}
          expandSignal={false}
        />
      )

      expect(runHeader(container)).toHaveTextContent('git push --force-with-lease')
      expect(runHeader(container)).not.toHaveTextContent('/bin/zsh')
    })
  })

  it('keeps a grouped active run to one stable row showing only the latest tool', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'date' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'cat package.json' }, state: 'running' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    const header = runHeader(container)
    expect(header).toHaveTextContent('Running 3 commands')
    expect(header).toHaveTextContent('cat package.json')
    expect(header).not.toHaveTextContent('date')
    expect(header).not.toHaveTextContent('pwd')
    expect(screen.getByText('Running 3 commands')).toHaveClass(
      'animate-pulse',
      'motion-reduce:animate-none'
    )
    expect(header.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('treats legacy tool calls without lifecycle state as active while the turn works', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: { command: 'sleep 5' } }]}
        expandSignal={false}
        activeTurnIsWorking
      />
    )

    expect(screen.getByText('Running 1 command')).toBeInTheDocument()
    expect(screen.getByText('sleep 5')).toBeInTheDocument()
  })

  it('keeps a completed tool payload collapsed until the run is expanded', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'shell',
        input: { command: 'printf hello' },
        state: 'completed'
      },
      { type: 'tool-result', output: 'hello' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)
    expect(screen.queryByText('hello')).toBeNull()
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

  it('settles a run the agent has moved past even while its last call still reports', () => {
    const { container } = render(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }
        ]}
        expandSignal={false}
        activeTurnIsWorking
        trailing={false}
      />
    )

    const header = runHeader(container)
    expect(header).toHaveAttribute('data-native-chat-tool-run-state', 'settled')
    expect(header).not.toHaveTextContent('Running')
    expect(header.querySelector('.animate-pulse')).toBeNull()
    expect(header.querySelector('.lucide-check')).toBeNull()
  })

  it('never animates a settled tool row with its completion check', () => {
    const { container } = render(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
          { type: 'tool-result', output: 'passed' }
        ]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )

    const settledRow = runHeader(container)
    expect(settledRow).toHaveTextContent('pnpm test')
    expect(settledRow.querySelector('.lucide-check')).toBeInTheDocument()
    // Windowing remounts settled rows on scroll; a mark that faded in would replay.
    expect(settledRow.querySelector('.lucide-check')).not.toHaveClass('animate-in')
    expect(settledRow.querySelector('.animate-pulse')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('refuses the completion mark to a collapsed run whose call failed', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'false' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 1', isError: true }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(container.querySelector('.lucide-check')).toBeNull()
    expect(runHeader(container)).toHaveTextContent(' · 1 failed')
    expect(runHeader(container)).toHaveAccessibleName(/Failed tool calls: 1/)
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
    expect(container.querySelector('[class*="destructive"]')).toBeNull()
    expect(screen.queryByText('exit 1')).toBeNull()
  })

  it('counts every failed call in a run, not just the last one', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'a' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 1', isError: true },
      { type: 'tool-call', name: 'shell', input: { command: 'b' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 2', isError: true },
      { type: 'tool-call', name: 'shell', input: { command: 'c' }, state: 'completed' },
      { type: 'tool-result', output: 'ok' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(runHeader(container)).toHaveTextContent('2 failed')
    expect(container.querySelector('.lucide-check')).toBeNull()
  })

  it('says nothing and keeps the mark when every call in the run succeeded', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'a' }, state: 'completed' },
      { type: 'tool-result', output: 'ok' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(runHeader(container)).not.toHaveTextContent('failed')
    expect(container.querySelector('.lucide-check')).toBeInTheDocument()
  })

  // Keep output behind each call’s disclosure to avoid doubling expanded runs with Result rows.
  it('keeps a call output behind the call row, not beside it', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'git log -1' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 128', isError: true }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />)

    expect(screen.queryByText('Result')).toBeNull()
    expect(screen.queryByText('exit 128')).toBeNull()

    // Click the member, since this single-call header names the same command.
    const rows = screen.getAllByText('git log -1')
    fireEvent.click(rows.at(-1)!.closest('button')!)

    expect(screen.getByText('exit 128')).toBeInTheDocument()
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

  it('shows the category glyph beside the word a classified row is named by', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'read',
        input: { command: "sed -n '1,200p' notes.txt", path: 'notes.txt' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const glyph = container.querySelector('.lucide-eye')
    expect(glyph).toBeInTheDocument()
    expect(glyph).toHaveAttribute('aria-hidden')
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('holds one glyph for a category across running, completed, and failed', () => {
    const searchCall = (state: 'running' | 'completed' | 'failed'): NativeChatBlock[] => [
      { type: 'tool-call', name: 'search', input: { query: 'beta' }, state }
    ]
    const { container, rerender } = render(
      <NativeChatToolRun blocks={searchCall('running')} expandSignal activeTurnIsWorking />
    )

    expect(leadingGlyphs(container)).toEqual(['lucide-search', 'lucide-search'])

    for (const settled of ['completed', 'failed'] as const) {
      rerender(
        <NativeChatToolRun blocks={searchCall(settled)} expandSignal activeTurnIsWorking={false} />
      )

      expect(leadingGlyphs(container)).toEqual(['lucide-search', 'lucide-search'])
    }
  })

  it('falls back to the generic tool glyph, not the terminal, for an unmodelled row', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'CreateWidget',
        input: { prompt: 'which?' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(container.querySelector('.lucide-square-terminal')).toBeNull()
    expect(container.querySelector('.lucide-wrench')).toBeInTheDocument()
  })

  it('agrees between the header and the row it names for an unmodelled tool', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'CreateWidget',
        input: { prompt: 'which?' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(leadingGlyphs(container)).toEqual(['lucide-wrench', 'lucide-wrench'])
  })

  // Unpaired results have translated labels rather than a tool name to classify.
  it('leaves an unpaired result row without a category glyph', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-result', output: 'first line' }]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(runHeader(container)).toHaveAccessibleName('Result')
    const resultRow = screen.getByRole('button', { name: 'Result first line' })
    // Keying a category off 'Result' would resolve a different glyph per locale.
    expect(
      [...(resultRow?.querySelectorAll('svg') ?? [])].map(
        (svg) => svg.getAttribute('class')?.match(/lucide-[a-z0-9-]+/)?.[0]
      )
    ).toEqual(['lucide-chevron-right'])
  })

  it('heads a projected diff run with the file-change glyph, not the generic one', () => {
    const projected = projectStructuredItemToNativeChat({
      itemId: 'file-change',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'diff',
        path: 'src/a.ts',
        patch: {
          head: '@@ -1 +1 @@\n-was\n+now',
          truncated: false,
          byteLength: 24,
          digest: 'a'.repeat(64)
        }
      }
    })

    const { container } = render(
      <NativeChatToolRun blocks={projected?.blocks ?? []} expandSignal />
    )

    expect(container.querySelector('.lucide-pencil')).toBeInTheDocument()
    expect(container.querySelector('.lucide-wrench')).toBeNull()
  })

  describe('the settled header glyph over a whole run', () => {
    // The header glyph describes the summarized run, not its last-finishing call.
    const call = (name: string, input: unknown): NativeChatBlock => ({
      type: 'tool-call',
      name,
      input,
      state: 'completed'
    })

    it('heads a run that is all reads with the read glyph', () => {
      const blocks: NativeChatBlock[] = [
        call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' }),
        call('read', { command: "sed -n '1,50p' b.ts", path: 'b.ts' })
      ]

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />
      )

      expect(leadingGlyphs(container)).toEqual(['lucide-eye', 'lucide-eye', 'lucide-eye'])
    })

    it('heads a run that is all shell with the terminal glyph, whatever each is named', () => {
      const blocks: NativeChatBlock[] = [
        call('shell', { command: 'npm test' }),
        call('Bash', { command: 'git status' })
      ]

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />
      )

      expect(leadingGlyphs(container)).toEqual([
        'lucide-square-terminal',
        'lucide-square-terminal',
        'lucide-square-terminal'
      ])
    })

    it('heads a run spanning categories with the generic tool glyph', () => {
      const blocks: NativeChatBlock[] = [
        call('shell', { command: 'npm test' }),
        call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' })
      ]

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />
      )

      expect(leadingGlyphs(container)).toEqual([
        'lucide-wrench',
        'lucide-square-terminal',
        'lucide-eye'
      ])
    })

    it('heads a single-call run with that call\u2019s own glyph', () => {
      const { container } = render(
        <NativeChatToolRun
          blocks={[call('Grep', { pattern: 'todo' })]}
          expandSignal
          activeTurnIsWorking={false}
        />
      )

      expect(leadingGlyphs(container)).toEqual(['lucide-search', 'lucide-search'])
    })

    it.each([1, 3])('labels a run of %s unpaired results without inventing tool calls', (count) => {
      const blocks: NativeChatBlock[] = Array.from({ length: count }, (_, index) => ({
        type: 'tool-result',
        output: `first line ${index}`
      }))

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />
      )

      expect(runHeader(container)).toHaveAccessibleName('Result')
      expect(runHeader(container)).not.toHaveTextContent(/tool calls?/)

      expect(leadingGlyphs(container)).toEqual([
        'lucide-check',
        ...blocks.map(() => 'lucide-chevron-right')
      ])
    })

    it('holds the run glyph across live and settled', () => {
      const blocks: NativeChatBlock[] = [
        call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' }),
        { type: 'tool-call', name: 'shell', input: { command: 'npm test' }, state: 'running' }
      ]

      const { container, rerender } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking />
      )

      // Keep the run’s identity glyph across state transitions instead of using the latest call’s category.
      expect(leadingGlyphs(container)[0]).toBe('lucide-wrench')
      rerender(<NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />)
      expect(leadingGlyphs(container)[0]).toBe('lucide-wrench')
    })
  })

  it('labels a bare list row by the command it ran rather than an invented path', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'list',
        input: { command: 'ls', cwd: '/repo' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(container.querySelector('.lucide-folder')).toBeInTheDocument()
    expect(screen.getByTitle('ls')).toHaveTextContent('ls')
  })

  // Unnamed group-hover matches the surrounding message too, revealing every member caret at once.
  describe('hover reveal', () => {
    const run: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls -la' }, state: 'completed' },
      { type: 'tool-result', output: 'a\nb' },
      { type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-result', output: '/tmp' }
    ]

    /** Read class attributes because SVG className is an SVGAnimatedString. */
    function hoverRevealed(container: HTMLElement): { element: Element; classes: string }[] {
      return [...container.querySelectorAll('[class*="group-hover"]')].map((element) => ({
        element,
        classes: element.getAttribute('class') ?? ''
      }))
    }

    it('scopes a row’s reveal to that row rather than the whole message', () => {
      // Open run, collapsed children — the state the turn caret leaves behind.
      const { container } = render(<NativeChatToolRun blocks={run} expandSignal />)

      const revealed = hoverRevealed(container)
      expect(revealed.length).toBeGreaterThan(0)
      revealed.forEach(({ classes }) => {
        expect(classes).not.toMatch(/(^|\s)group-hover:/)
      })
    })

    it('puts every reveal inside the row button that governs it', () => {
      const { container } = render(<NativeChatToolRun blocks={run} expandSignal />)

      hoverRevealed(container).forEach(({ element, classes }) => {
        const scope = /group-hover\/([a-z-]+):/.exec(classes)?.[1]
        expect(scope).toBeDefined()
        expect(element.closest(`.group\\/${scope}`)).not.toBeNull()
      })
    })

    it('keeps every row’s chevron in view at the row’s right edge', () => {
      const { container } = render(<NativeChatToolRun blocks={run} expandSignal />)

      const chevrons = [...container.querySelectorAll('.border-l button svg.lucide-chevron-right')]
      expect(chevrons.length).toBeGreaterThan(1)
      chevrons.forEach((chevron) => {
        expect(chevron.getAttribute('class')).not.toContain('opacity-0')
      })
    })
  })
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
