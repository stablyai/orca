// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatToolLine } from './NativeChatToolLine'
import { NativeChatToolRun } from './NativeChatToolRun'
import type { NativeChatToolCallBlock } from '../../../../shared/native-chat-types'

afterEach(cleanup)

describe('tool sentence rows', () => {
  it.each([
    ['Bash', { command: 'pnpm test' }, 'Ran', 'pnpm test', false],
    ['Read', { file_path: '/repo/src/main.ts' }, 'Read', 'main.ts', true],
    ['Edit', { file_path: 'C:\\repo\\main.ts' }, 'Edited', 'main.ts', true],
    ['Write', { file_path: '/repo/new.ts' }, 'Edited', 'new.ts', true],
    ['MultiEdit', { file_path: '/repo/main.ts' }, 'Edited', 'main.ts', true],
    ['Grep', { pattern: 'TODO', path: '/repo' }, 'Searched', 'TODO', true],
    ['Glob', { pattern: '**/*.ts' }, 'Searched', '**/*.ts', true],
    ['search', { query: 'settings', command: 'rg settings' }, 'Searched', 'settings', true],
    ['web_search', { query: 'react docs' }, 'Searched the web', 'react docs', true],
    ['WebFetch', { url: 'https://example.com/docs' }, 'Fetched', 'example.com/docs', true],
    ['CreateWidget', { description: 'a widget' }, 'CreateWidget', 'a widget', true],
    ['list', { directory: '/repo' }, 'Listed', '/repo', true],
    ['exec', { command: 'git diff' }, 'Ran', 'git diff', false],
    ['local_shell', { command: 'pwd' }, 'Ran', 'pwd', false]
  ])('describes %s with a verb and target', (name, input, verb, target, verbShown) => {
    const { container } = render(
      <NativeChatToolLine block={{ type: 'tool-call', name, input, state: 'completed' }} />
    )
    // A command is its own row: the run's header already says it ran.
    expect(screen.queryByText(verb, { selector: 'span:not(.sr-only)' }) !== null).toBe(verbShown)
    expect(screen.getByText(target, { selector: 'span:not(.sr-only)' })).toHaveClass(
      'text-chat-foreground'
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(new RegExp(name))
    expect(screen.getByRole('button')).toHaveAccessibleName(new RegExp(verb))
    expect(container.querySelector('.font-semibold')).toBeNull()
  })

  it('tints the glyph of a failed call, and of no other', () => {
    const glyphOf = (state: 'completed' | 'failed', isError: boolean): Element | null => {
      const { container, unmount } = render(
        <NativeChatToolLine
          block={{ type: 'tool-call', name: 'Bash', input: { command: 'ls src' }, state }}
          result={{ type: 'tool-result', output: 'out', isError }}
        />
      )
      const tinted = container.querySelector('.text-destructive\\/70')
      unmount()
      return tinted
    }
    expect(glyphOf('failed', true)).not.toBeNull()
    expect(glyphOf('completed', true)).not.toBeNull()
    expect(glyphOf('completed', false)).toBeNull()
  })

  it('retains full paths in titles and accessible targets', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/src/main.ts' } }}
      />
    )
    expect(screen.getByTitle('/repo/src/main.ts')).toHaveTextContent('main.ts')
    expect(screen.getByTitle('/repo/src/main.ts')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button')).toHaveAccessibleName(/Read.*\/repo\/src\/main.ts/)
  })

  it('keeps integration identity in plain text even for a command-shaped tool name', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'shell',
          input: { command: 'inspect' },
          state: 'completed',
          mcpIdentity: { server: 'my_server', tool: 'shell' }
        }}
      />
    )
    expect(screen.getByText('My server')).toBeInTheDocument()
    expect(screen.getByText('shell')).toBeInTheDocument()
    expect(screen.queryByText('Ran')).toBeNull()
    expect(screen.getByText('inspect')).not.toHaveClass('font-mono')
    expect(screen.getByText('inspect')).not.toHaveAttribute('data-native-chat-code-content')
  })

  it('counts changed lines rather than unchanged lines in an edit', () => {
    const block: NativeChatToolCallBlock = {
      type: 'tool-call',
      name: 'Edit',
      input: { file_path: 'main.ts', old_string: 'same\nold\n', new_string: 'same\nnew\nextra\n' },
      state: 'completed'
    }
    render(<NativeChatToolRun blocks={[block]} expandSignal />)
    expect(screen.getByRole('button', { name: /^Edited main\.ts/ })).toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
    expect(screen.getByText('-1')).toBeInTheDocument()
  })

  it('omits counts when an edit supplies no diff', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: 'main.ts' },
          state: 'completed'
        }}
      />
    )
    expect(screen.queryByText(/^[+-]\d+$/)).toBeNull()
  })

  it.each([
    ['Bash', { command: 'pnpm test' }, 'Running'],
    ['exec', { command: 'git diff' }, 'Running'],
    ['local_shell', { command: 'pwd' }, 'Running'],
    ['Read', { file_path: '/repo/a.ts' }, 'Reading'],
    ['Write', { file_path: '/repo/a.ts', content: 'new' }, 'Editing'],
    ['Grep', { pattern: 'TODO' }, 'Searching'],
    ['list', { directory: '/repo' }, 'Listing'],
    ['web_search', { query: 'docs' }, 'Searching the web'],
    ['WebFetch', { url: 'https://example.com/docs' }, 'Fetching']
  ])('uses present tense for a running %s', (name, input, verb) => {
    render(<NativeChatToolLine block={{ type: 'tool-call', name, input, state: 'running' }} />)
    expect(screen.getByText(verb)).toBeInTheDocument()
  })

  it.each(['failed', undefined] as const)('never claims an edit landed with state %s', (state) => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: '/repo/a.ts', old_string: 'missing', new_string: 'new' },
          state
        }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(
      state === 'failed' ? 'Edit Tried to edit /repo/a.ts' : 'Edit /repo/a.ts'
    )
    expect(screen.queryByText('Edited')).toBeNull()
    expect(screen.queryByText(/^[+-]\d+$/)).toBeNull()
  })

  it('does not treat an error result as a completed edit', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Edit',
          input: { file_path: '/repo/a.ts' },
          state: 'completed'
        }}
        result={{ type: 'tool-result', output: 'String to replace not found', isError: true }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('Edit Tried to edit /repo/a.ts')
    expect(screen.queryByText('Edited')).toBeNull()
  })

  it('uses a successful legacy result as completion evidence', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Bash', input: { command: 'pwd' } }}
        result={{ type: 'tool-result', output: '/repo' }}
      />
    )
    expect(screen.getByText('Ran')).toBeInTheDocument()
  })

  it.each([false, true])(
    'keeps a long Unicode fetch target unchanged (JSON input: %s)',
    (jsonInput) => {
      const url = `https://example.com/日本語/${'segment/'.repeat(25)}end`
      const input = jsonInput ? JSON.stringify({ url }) : { url }
      render(
        <NativeChatToolLine
          block={{ type: 'tool-call', name: 'WebFetch', input, state: 'completed' }}
        />
      )
      expect(screen.getByTitle(url)).toHaveTextContent(url.slice('https://'.length))
      expect(screen.getByTitle(url)).not.toHaveTextContent('%E2%80%A6')
    }
  )

  it('keeps metadata and errors while toggling output behind the sentence', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Bash',
          input: { command: 'false' },
          exitCode: 1,
          durationMs: 1200
        }}
        result={{ type: 'tool-result', output: 'command failed', isError: true }}
      />
    )
    const button = screen.getByRole('button')
    expect(button).toHaveAccessibleName(/Bash.*Ran.*false.*exit 1.*1s/)
    expect(screen.getByText('1s').parentElement).toHaveClass('ml-auto', 'tabular-nums', 'font-sans')
    expect(screen.queryByText('command failed')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByText('command failed')).toHaveClass(
      'text-destructive',
      'bg-chat-code-surface',
      'border-chat-code-border',
      'rounded-lg',
      'text-xs'
    )
    fireEvent.click(button)
    expect(screen.queryByText('command failed')).toBeNull()
  })

  it.each([
    ['Bash', { type: 'tool-result', output: 'failed', isError: true }, undefined],
    ['exec', { type: 'tool-result', output: 'failed', isError: true }, 1],
    ['local_shell', undefined, 2],
    ['Bash', { type: 'tool-result', output: 'ok' }, undefined]
  ] as const)(
    'says Ran for %s with execution evidence, including failures',
    (name, result, exitCode) => {
      render(
        <NativeChatToolLine
          block={{
            type: 'tool-call',
            name,
            input: { command: 'false' },
            state: 'failed',
            exitCode
          }}
          result={result}
        />
      )
      expect(screen.getByText('Ran')).toBeInTheDocument()
      expect(screen.queryByText('Running')).toBeNull()
    }
  )

  it.each([
    ['Read', { file_path: '/repo/a.ts' }, 'Tried to read'],
    ['Grep', { pattern: 'TODO' }, 'Tried to search'],
    ['list', { directory: '/repo' }, 'Tried to list'],
    ['WebFetch', { url: 'https://example.com' }, 'Tried to fetch'],
    ['web_search', { query: 'docs' }, 'Tried to search the web']
  ])('describes a failed %s without claiming success', (name, input, verb) => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input, state: 'completed' }}
        result={{ type: 'tool-result', output: 'unavailable', isError: true }}
      />
    )
    expect(screen.getByText(verb)).toBeInTheDocument()
  })

  it.each([
    ['Bash', { command: 'pnpm test' }],
    ['exec', JSON.stringify({ cmd: 'pnpm test' })],
    ['Bash', 'pnpm test']
  ])('omits duplicate input for a complete %s command row', (name, input) => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input, state: 'completed' }}
        result={{ type: 'tool-result', output: 'all passed' }}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(container.querySelectorAll('pre')).toHaveLength(1)
    expect(container.querySelector('pre')).toHaveTextContent('all passed')
  })

  it.each([
    [{ command: 'pnpm test', description: 'Run the suite' }],
    [{ command: ['printf', '%s', 'a b'] }],
    [{ command: '/bin/zsh -lc "pnpm test"' }]
  ])('opens a command to its output alone, never its raw arguments', (input) => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Bash', input, state: 'completed' }}
        result={{ type: 'tool-result', output: 'all passed' }}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual([
      'all passed'
    ])
  })

  it('does not offer empty detail for a short command without output', () => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'completed' }}
      />
    )
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-expanded')
    expect(container.querySelector('pre')).toBeNull()
  })

  it.each([false, true])(
    'shows the full abbreviated command as plain text (JSON: %s)',
    (jsonInput) => {
      const command = `pnpm test ${'src/renderer/tests/long-path/'.repeat(170)}end.test.ts`
      const input = jsonInput ? JSON.stringify({ command }) : { command }
      const { container } = render(
        <NativeChatToolLine
          block={{ type: 'tool-call', name: 'exec', input, state: 'completed' }}
          result={{ type: 'tool-result', output: 'all passed' }}
        />
      )
      expect(screen.getByTitle(command)).toHaveTextContent(/…$/)
      expect(container.querySelector('pre')).toBeNull()
      fireEvent.click(screen.getByRole('button'))
      const detail = container.querySelector('pre')
      expect(detail?.textContent).toBe(command)
      expect(detail).toHaveClass('font-mono', 'bg-chat-code-surface')
      expect(container.querySelectorAll('pre')).toHaveLength(2)
    }
  )

  it('keeps a long plain command with surrounding whitespace complete', () => {
    const command = `  pnpm test ${'src/renderer/tests/long-path/'.repeat(170)}end.test.ts  `
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Bash', input: { command }, state: 'completed' }}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(container.querySelector('pre')?.textContent).toBe(command)
  })

  it('opens an edit that has not landed to the change it proposes', () => {
    const { container } = render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Edit',
          state: 'running',
          input: { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' }
        }}
      />
    )
    expect(container.textContent).not.toContain('now')
    fireEvent.click(screen.getByRole('button'))
    expect(container.textContent).toContain('now')
  })

  it.each(['exec', 'shell', 'Bash'])('offers nothing to open on a running %s command', (name) => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input: { command: 'ls' }, state: 'running' }}
      />
    )
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-expanded')
  })

  it('offers nothing to open on a call that has produced no output', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'lookup_ticket', input: { ticket: 'ORC-1' } }}
      />
    )
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-expanded')
  })

  it('shows a read as its output alone, not the arguments its row already names', () => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/a.ts', offset: 10 } }}
        result={{ type: 'tool-result', output: 'const a = 1' }}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual([
      'const a = 1'
    ])
  })

  it.each(['Task', 'Agent'])(
    'uses the unchanged description for live and settled %s calls',
    (name) => {
      const description = `explore settings search entries ${'without rewriting '.repeat(8)}end`
      const input = {
        description,
        prompt: 'longer private instructions',
        query: 'not the description'
      }
      const { rerender } = render(
        <NativeChatToolLine block={{ type: 'tool-call', name, input, state: 'running' }} />
      )
      expect(screen.getByText('Subagent')).toBeInTheDocument()
      expect(screen.getByTitle(description).textContent).toBe(description)
      rerender(
        <NativeChatToolLine
          block={{ type: 'tool-call', name, input: JSON.stringify(input), state: 'completed' }}
        />
      )
      expect(screen.getByText('Subagent')).toBeInTheDocument()
      expect(screen.getByTitle(description).textContent).toBe(description)
      expect(screen.getByRole('button')).toHaveAccessibleName(new RegExp(name))
    }
  )

  it('preserves integration identity for an integration named Agent', () => {
    render(
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          name: 'Agent',
          input: { description: 'inspect' },
          state: 'completed',
          mcpIdentity: { server: 'my_server', tool: 'Agent' }
        }}
      />
    )
    expect(screen.getByText('My server')).toBeInTheDocument()
    expect(screen.queryByText('Subagent')).toBeNull()
  })

  it('still renders result-only rows', () => {
    render(<NativeChatToolLine block={{ type: 'tool-result', output: 'first\nsecond' }} />)
    fireEvent.click(screen.getByRole('button', { name: /Result/ }))
    expect(screen.getByText('first second', { selector: 'pre' })).toHaveClass(
      'text-chat-foreground'
    )
  })
})
