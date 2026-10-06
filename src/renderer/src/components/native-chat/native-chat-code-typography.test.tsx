// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

describe('chat code typography opt-in', () => {
  it('keeps live tool names and file paths outside code-size styling', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'Read', input: { file_path: 'src/app.ts' } }]}
        expandSignal
        activeTurnIsWorking
      />
    )
    expect(screen.getByText('Read src/app.ts')).not.toHaveAttribute('data-native-chat-code-content')
    expect(screen.getByTitle('src/app.ts')).not.toHaveAttribute('data-native-chat-code-content')
  })

  it('opts command previews and expanded output into code size', () => {
    const { container } = render(
      <NativeChatToolRun
        blocks={[
          { type: 'tool-call', callId: 'shell', name: 'Bash', input: { command: 'git status' } },
          { type: 'tool-result', callId: 'shell', output: 'working tree clean' }
        ]}
        expandSignal
        activeTurnIsWorking
      />
    )
    expect(screen.getByTitle('git status')).toHaveAttribute('data-native-chat-code-content')
    expect(container.querySelector('pre')).toHaveAttribute('data-native-chat-code-content')
    expect(screen.getByText('Ran')).not.toHaveAttribute('data-native-chat-code-content')
    const header = container.querySelector('button')
    expect(header).not.toBeNull()
    expect(header?.querySelector('[data-native-chat-code-content]')).toBeNull()
  })
})
