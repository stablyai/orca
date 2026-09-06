// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

/** The first glyph of every row — the run header, then each tool line. Named by
 *  lucide's own class, so an icon that swaps shows up as a different name. */
function leadingGlyphs(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('button')].map(
    (button) =>
      button
        .querySelector('svg')
        ?.getAttribute('class')
        ?.match(/lucide-[a-z0-9-]+/)?.[0] ?? null
  )
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

    expect(screen.getByTitle('src/index.ts')).toHaveTextContent('src/index.ts')
    expect(screen.queryByTitle('{"file_path":"src/index.ts","offset":10}')).toBeNull()
  })

  it('renders structured apply_patch changes as a reviewable diff instead of JSON', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'apply_patch',
        // The patch lives on the call in this lane, so the provider's own
        // completion is what says the edit landed.
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

    expect(screen.getByText('after')).toBeInTheDocument()
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.getByText('Edited file')).toBeInTheDocument()
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

    // Row grounds come from the diff tokens, not a hardcoded palette value.
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

    expect(screen.queryByText('Edited file')).toBeNull()
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

    expect(screen.queryByText('Edited file')).toBeNull()
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
    // The header states the change; there is no body behind a disclosure.
    expect(screen.getByText('Deleted file').closest('button')).not.toHaveAttribute('aria-expanded')
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

    // A defined expandOverride opens the run while leaving each card closed.
    render(<NativeChatToolRun blocks={blocks} expandSignal={false} expandOverride />)

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

  it('keeps a grouped active run to one stable row showing only the latest tool', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'date' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'cat package.json' }, state: 'running' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    const activeLabel = screen.getByText('Running cat package.json')
    expect(activeLabel).toBeInTheDocument()
    expect(activeLabel).toHaveClass('animate-pulse', 'motion-reduce:animate-none')
    expect(screen.queryByText('Running date')).toBeNull()
    expect(screen.queryByText('Running pwd')).toBeNull()
    expect(screen.queryByText('Ran 3 commands and used 1 tool')).toBeNull()
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

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
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

  it('replaces the live row with a compact result when the active call settles', () => {
    const runningBlocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }
    ]
    const { rerender } = render(<NativeChatToolRun blocks={runningBlocks} expandSignal={false} />)

    expect(screen.getByText('Running sleep 1')).toBeInTheDocument()

    rerender(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'completed' },
          { type: 'tool-result', output: 'done' }
        ]}
        expandSignal={false}
      />
    )

    expect(screen.queryByText('Running sleep 1')).toBeNull()
    expect(screen.getByText('shell sleep 1')).toBeInTheDocument()
  })

  it('keeps failed tool runs visually neutral while collapsed', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'false' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 1', isError: true }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(container.querySelector('.lucide-check')).toBeInTheDocument()
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
    expect(screen.queryByText('exit 1')).toBeNull()
  })

  it('keeps settled tool activity behind the completed turn disclosure', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'git log -1' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 128', isError: true }
    ]

    const { rerender } = render(
      <NativeChatToolRun
        blocks={blocks}
        expandSignal={false}
        expandOverride={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.queryByText('git log -1')).toBeNull()
    expect(screen.queryByText('exit 128')).toBeNull()

    rerender(
      <NativeChatToolRun
        blocks={blocks}
        expandSignal={false}
        expandOverride
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('shell git log -1')).toBeInTheDocument()
  })

  it('settles an orphaned running call when its turn lifecycle has ended', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }
    ]

    const { container } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />
    )

    expect(screen.queryByText('Running sleep 1')).toBeNull()
    expect(container.querySelector('.lucide-check')).toBeInTheDocument()
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
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
    expect(screen.getByText('read')).toBeInTheDocument()
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

      // A leading check here would read as the row changing identity on settle.
      expect(leadingGlyphs(container)).toEqual(['lucide-search', 'lucide-search'])
    }
  })

  it('falls back to the generic tool glyph, not the terminal, for an unmodelled row', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: { prompt: 'which?' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    // A terminal here would assert a shell ran when nothing says one did.
    expect(container.querySelector('.lucide-square-terminal')).toBeNull()
    expect(container.querySelector('.lucide-wrench')).toBeInTheDocument()
  })

  it('agrees between the header and the row it names for an unmodelled tool', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'AskUserQuestion',
        input: { prompt: 'which?' },
        state: 'completed'
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    // Header and row read the same function, so one run cannot show two glyphs.
    expect(leadingGlyphs(container)).toEqual(['lucide-wrench', 'lucide-wrench'])
  })

  it('leaves a result row without a category glyph, its word being translated copy', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'read', input: { path: 'notes.txt' }, state: 'completed' },
      { type: 'tool-result', output: 'first line' }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const resultRow = screen.getByText('Result').closest('button')
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
      <NativeChatToolRun blocks={projected?.blocks ?? []} expandSignal={false} expandOverride />
    )

    // The run renders an edited-file card, so a wrench above it reads as a tool
    // this vocabulary does not model.
    expect(container.querySelector('.lucide-pencil')).toBeInTheDocument()
    expect(container.querySelector('.lucide-wrench')).toBeNull()
  })

  describe('the settled header glyph over a whole run', () => {
    // The header's text summarizes the run's first calls, so its glyph has to
    // describe the same run rather than whichever call happened to finish last.
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

      // An eye here — the last call's glyph — would claim a category the summary
      // beside it does not describe.
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

    it('leaves a run with no tool calls headed by no category glyph', () => {
      const blocks: NativeChatBlock[] = [{ type: 'tool-result', output: 'first line' }]

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking={false} />
      )

      // Only the trailing check and the chevron; a wrench here would claim a
      // tool category for a run holding no tool call.
      expect(leadingGlyphs(container)).toEqual(['lucide-check', 'lucide-chevron-right'])
    })

    it('keeps naming the active call while the run is still running', () => {
      const blocks: NativeChatBlock[] = [
        call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' }),
        { type: 'tool-call', name: 'shell', input: { command: 'npm test' }, state: 'running' }
      ]

      const { container } = render(
        <NativeChatToolRun blocks={blocks} expandSignal activeTurnIsWorking />
      )

      // The running header names one call, so its glyph is that call's.
      expect(leadingGlyphs(container)[0]).toBe('lucide-square-terminal')
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
})
