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
    ['Bash', { command: 'pnpm test' }, 'Ran', 'pnpm test'],
    ['Read', { file_path: '/repo/src/main.ts' }, 'Read', 'main.ts'],
    ['Edit', { file_path: 'C:\\repo\\main.ts' }, 'Edited', 'main.ts'],
    ['Write', { file_path: '/repo/new.ts' }, 'Edited', 'new.ts'],
    ['MultiEdit', { file_path: '/repo/main.ts' }, 'Edited', 'main.ts'],
    ['Grep', { pattern: 'TODO', path: '/repo' }, 'Searched', 'TODO'],
    ['Glob', { pattern: '**/*.ts' }, 'Searched', '**/*.ts'],
    ['search', { query: 'settings', command: 'rg settings' }, 'Searched', 'settings'],
    ['web_search', { query: 'react docs' }, 'Searched the web', 'react docs'],
    ['WebFetch', { url: 'https://example.com/docs' }, 'Fetched', 'example.com/docs'],
    ['CreateWidget', { description: 'a widget' }, 'CreateWidget', 'a widget'],
    ['list', { directory: '/repo' }, 'Listed', '/repo'],
    ['exec', { command: 'git diff' }, 'Ran', 'git diff'],
    ['local_shell', { command: 'pwd' }, 'Ran', 'pwd']
  ])('describes %s with a verb and target', (name, input, verb, target) => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input, state: 'completed' }}
        initiallyExpanded={false}
      />
    )
    expect(screen.getByText(verb, { selector: 'span:not(.sr-only)' })).toBeInTheDocument()
    expect(screen.getByText(target, { selector: 'span:not(.sr-only)' })).toHaveClass(
      'text-chat-foreground'
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(new RegExp(name))
    expect(container.querySelector('.font-semibold')).toBeNull()
    expect(container.querySelector('.font-mono') !== null).toBe(
      ['Bash', 'exec', 'local_shell'].includes(name)
    )
  })

  it('retains full paths in titles and accessible targets', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name: 'Read', input: { file_path: '/repo/src/main.ts' } }}
        initiallyExpanded={false}
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
        initiallyExpanded={false}
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
    render(<NativeChatToolRun blocks={[block]} expandSignal={false} expandOverride />)
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
        initiallyExpanded={false}
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
    render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input, state: 'running' }}
        initiallyExpanded={false}
      />
    )
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
        initiallyExpanded={false}
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
        initiallyExpanded={false}
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
        initiallyExpanded={false}
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
          initiallyExpanded={false}
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
        initiallyExpanded={false}
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
          initiallyExpanded={false}
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
        initiallyExpanded={false}
      />
    )
    expect(screen.getByText(verb)).toBeInTheDocument()
  })

  it.each([
    ['Bash', { command: 'pnpm test' }],
    ['exec', JSON.stringify({ cmd: 'pnpm test' })],
    ['Bash', 'pnpm test']
  ])('omits duplicate input for a complete %s command chip', (name, input) => {
    const { container } = render(
      <NativeChatToolLine
        block={{ type: 'tool-call', name, input, state: 'completed' }}
        result={{ type: 'tool-result', output: 'all passed' }}
      />
    )
    expect(screen.getByTitle('pnpm test')).toHaveClass('font-mono')
    expect(container.querySelectorAll('pre')).toHaveLength(1)
    expect(container.querySelector('pre')).toHaveTextContent('all passed')
  })

  it.each([
    [{ command: 'pnpm test', description: 'Run the suite' }, '"description": "Run the suite"'],
    [{ command: ['printf', '%s', 'a b'] }, '"command": [\n    "printf",\n    "%s",\n    "a b"'],
    [{ command: '/bin/zsh -lc "pnpm test"' }, '/bin/zsh -lc \\"pnpm test\\"']
  ])(
    'keeps the original command input accessible when the chip omits structure',
    (input, detail) => {
      const { container } = render(
        <NativeChatToolLine
          block={{ type: 'tool-call', name: 'Bash', input, state: 'completed' }}
          initiallyExpanded={false}
        />
      )
      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelector('pre')).toBeNull()
      fireEvent.click(screen.getByRole('button'))
      expect(container.querySelector('pre')?.textContent).toContain(detail)
    }
  )

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
          initiallyExpanded={false}
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
        initiallyExpanded={false}
      />
    )
    fireEvent.click(screen.getByRole('button'))
    expect(container.querySelector('pre')?.textContent).toBe(command)
  })

  it('retains structured input detail for other tools', () => {
    const input = { file_path: '/repo/a.ts', offset: 10 }
    const { container } = render(
      <NativeChatToolLine block={{ type: 'tool-call', name: 'Read', input }} />
    )
    expect(container.querySelector('pre')?.textContent).toBe(JSON.stringify(input, null, 2))
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
        <NativeChatToolLine
          block={{ type: 'tool-call', name, input, state: 'running' }}
          initiallyExpanded={false}
        />
      )
      expect(screen.getByText('Subagent')).toBeInTheDocument()
      expect(screen.getByTitle(description).textContent).toBe(description)
      rerender(
        <NativeChatToolLine
          block={{ type: 'tool-call', name, input: JSON.stringify(input), state: 'completed' }}
          initiallyExpanded={false}
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
        initiallyExpanded={false}
      />
    )
    expect(screen.getByText('My server')).toBeInTheDocument()
    expect(screen.queryByText('Subagent')).toBeNull()
  })

  it('still renders result-only rows', () => {
    render(
      <NativeChatToolLine
        block={{ type: 'tool-result', output: 'first\nsecond' }}
        initiallyExpanded={false}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Result/ }))
    expect(screen.getByText('first second', { selector: 'pre' })).toHaveClass(
      'text-chat-foreground'
    )
  })
})
