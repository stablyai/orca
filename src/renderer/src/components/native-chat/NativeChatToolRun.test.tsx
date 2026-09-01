// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

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

    expect(screen.getByText('+after')).toBeInTheDocument()
    expect(screen.getByText('-before')).toBeInTheDocument()
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

    expect(screen.getByText('+after')).toHaveClass(
      'bg-emerald-500/10',
      'text-[var(--git-decoration-added)]'
    )
    expect(screen.getByText('-before')).toHaveClass(
      'bg-rose-500/10',
      'text-[var(--git-decoration-deleted)]'
    )
    expect(container).not.toHaveTextContent('"changes"')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps a grouped active run to one stable row showing only the latest tool', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'shell', input: { command: 'date' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-call', name: 'shell', input: { command: 'cat package.json' }, state: 'running' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(screen.getByText('Running cat package.json')).toBeInTheDocument()
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
})
