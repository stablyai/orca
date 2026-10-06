// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

function runHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('button')
  if (!header) {
    throw new Error('run header did not render')
  }
  return header
}

describe('tool run sentences', () => {
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
    expect(screen.getByText('bloqueado · falló')).toBeInTheDocument()
  })
})
