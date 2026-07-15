// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatToolRun } from './NativeChatToolRun'

function renderRun(
  blocks: NativeChatBlock[],
  options: {
    isWorking?: boolean
    onLinkClick?: React.ComponentProps<typeof NativeChatToolRun>['onLinkClick']
  } = {}
): void {
  render(
    <TooltipProvider>
      <NativeChatToolRun
        blocks={blocks}
        expandSignal={false}
        isWorking={options.isWorking}
        onLinkClick={options.onLinkClick}
      />
    </TooltipProvider>
  )
}

describe('NativeChatToolRun', () => {
  afterEach(() => cleanup())

  it('collapses completed activity and renders one row per call/result pair', () => {
    renderRun([
      { type: 'tool-call', name: 'Read', input: { path: 'src/app.ts' }, callId: 'read' },
      { type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' }, callId: 'test' },
      { type: 'tool-result', output: 'tests passed', callId: 'test' },
      { type: 'tool-result', output: 'file contents', callId: 'read' }
    ])

    const activity = screen.getByRole('button', { name: /2 activities/i })
    expect(activity).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('tests passed')).not.toBeInTheDocument()

    fireEvent.click(activity)

    expect(activity).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /^Result/i })).not.toBeInTheDocument()

    const bash = screen.getAllByRole('button', { name: /Bash.*pnpm test/i }).at(-1)!
    fireEvent.click(bash)
    expect(screen.getByText('tests passed')).toBeInTheDocument()
  })

  it('keeps running and failed states visible while collapsed', () => {
    const { rerender } = render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'Bash', input: { command: 'pnpm test' } }]}
        expandSignal={false}
        isWorking
      />
    )
    expect(screen.getByRole('button', { name: /Running/i })).toBeInTheDocument()

    rerender(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', name: 'Edit', input: { path: 'src/app.ts' } },
          { type: 'tool-result', output: 'permission denied', isError: true }
        ]}
        expandSignal={false}
      />
    )
    expect(screen.getByRole('button', { name: /Failed/i })).toBeInTheDocument()
  })

  it('shows a failure and the current running operation together while collapsed', () => {
    renderRun(
      [
        {
          type: 'tool-call',
          name: 'Edit',
          input: { path: 'src/app.ts' },
          callId: 'edit'
        },
        {
          type: 'tool-result',
          output: 'permission denied',
          callId: 'edit',
          outcome: 'error'
        },
        {
          type: 'tool-call',
          name: 'Bash',
          input: { command: 'pnpm test' },
          callId: 'test'
        }
      ],
      { isWorking: true }
    )

    const activity = screen.getByRole('button', {
      name: /2 activities.*Bash.*pnpm test.*Failed.*Running/i
    })
    expect(activity).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(activity)
    expect(screen.getByRole('button', { name: /^Edit.*Failed/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Bash.*Running/i })).toBeInTheDocument()
  })

  it('shows successful reported files separately and opens their bounded diff', () => {
    const onLinkClick = vi.fn((event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
    })
    renderRun(
      [
        {
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: 'src/app.ts', old_string: 'old', new_string: 'new' }
        },
        { type: 'tool-result', output: 'done' }
      ],
      { onLinkClick }
    )

    const files = screen.getByRole('button', { name: /1 reported file/i })
    expect(files).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(files)

    const path = screen.getByRole('button', { name: 'src/app.ts' })
    fireEvent.click(path)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'src/app.ts')

    const fileDiff = screen.getByRole('button', { name: 'Show diff for src/app.ts' })
    fireEvent.click(fileDiff)
    expect(fileDiff).toHaveAttribute('aria-expanded', 'true')
    expect(fileDiff).toHaveAccessibleName('Hide diff for src/app.ts')
    expect(screen.getByText('-old')).toBeInTheDocument()
    expect(screen.getByText('+new')).toBeInTheDocument()
    expect(screen.queryByText('+1')).not.toBeInTheDocument()
    expect(screen.queryByText('-1')).not.toBeInTheDocument()
  })

  it('encodes literal file suffix characters before using the shared link handler', () => {
    const onLinkClick = vi.fn()
    renderRun(
      [
        {
          type: 'tool-call',
          name: 'Edit',
          input: { path: 'src/name#draft?.ts:12', old_string: 'old', new_string: 'new' }
        },
        { type: 'tool-result', output: 'done' }
      ],
      { onLinkClick }
    )

    fireEvent.click(screen.getByRole('button', { name: /1 reported file/i }))
    fireEvent.click(screen.getByRole('button', { name: 'src/name#draft?.ts:12' }))

    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'src/name%23draft%3F.ts%3A12')
  })

  it('attributes a multi-file patch to each file without leaking sibling lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/a.ts',
      '+only-a',
      '*** Add File: src/b.ts',
      '+only-b',
      '*** End Patch'
    ].join('\n')
    renderRun([
      { type: 'tool-call', name: 'apply_patch', input: patch },
      { type: 'tool-result', output: 'Done!' }
    ])

    fireEvent.click(screen.getByRole('button', { name: /2 reported files/i }))
    expect(screen.getAllByText('+1')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Show diff for src/a.ts' }))

    expect(screen.getByText('+only-a')).toBeInTheDocument()
    expect(screen.queryByText('+only-b')).not.toBeInTheDocument()
  })

  it('shows explicit truncation when a bounded file diff is incomplete', () => {
    renderRun([
      {
        type: 'tool-call',
        name: 'Write',
        input: { path: 'src/large.ts', content: 'line\n'.repeat(10_000) }
      },
      { type: 'tool-result', output: 'done' }
    ])

    fireEvent.click(screen.getByRole('button', { name: /1 reported file/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Show diff for src/large.ts' }))

    expect(screen.getByText(/Diff truncated/i)).toBeInTheDocument()
  })

  it('does not make a detail-free lifecycle row focusable', () => {
    renderRun([{ type: 'tool-result', output: '', outcome: 'success' }])

    fireEvent.click(screen.getByRole('button', { name: /1 activity/i }))
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
