// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalToolCallItem } from '../../../../shared/agent-session-journal-types'
import { interruptedAgentJournalToolCall } from '../../../../shared/agent-journal-tool-call-lifecycle'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatToolRun } from './NativeChatToolRun'
import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

afterEach(cleanup)

function runHeader(container: HTMLElement): HTMLElement {
  const header = container.querySelector('button')
  if (!header) {
    throw new Error('run header did not render')
  }
  return header
}

/** The blocks a structured chat draws for one journal tool row. */
function projected(itemId: string, body: AgentJournalToolCallItem): NativeChatBlock[] {
  return (
    projectStructuredItemToNativeChat({ itemId, sequence: 1, revision: 1, observedAt: 1, body })
      ?.blocks ?? []
  )
}

const output = (head: string) => ({ head, digest: 'd', byteLength: head.length, truncated: false })

function shell(
  command: string,
  state: AgentJournalToolCallItem['state']
): AgentJournalToolCallItem {
  return { kind: 'tool-call', name: 'shell', input: { command }, state }
}

describe('NativeChatToolRun call counts', () => {
  it('says a call a stop cut short was interrupted, not failed, and marks no success', () => {
    const blocks = projected(
      'sleep',
      interruptedAgentJournalToolCall({
        ...shell('sleep 20', 'running'),
        output: output('partial')
      })
    )
    const { container } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />
    )
    const header = runHeader(container)
    expect(header).toHaveTextContent('1 interrupted')
    expect(header).not.toHaveTextContent('failed')
    expect(header).toHaveAccessibleName(/Interrupted tool calls: 1/)
    expect(header.querySelector('.lucide-check')).toBeNull()
  })

  it('names a failure and an interruption in one quiet mark', () => {
    const blocks = [
      ...projected('false', { ...shell('false', 'failed'), output: output('exit 1') }),
      ...projected('sleep', interruptedAgentJournalToolCall(shell('sleep 20', 'running')))
    ]
    const { container } = render(
      <NativeChatToolRun blocks={blocks} expandSignal={false} activeTurnIsWorking={false} />
    )
    const header = runHeader(container)
    expect(header).toHaveTextContent('1 failed, 1 interrupted')
    expect(header).toHaveAccessibleName(/Failed tool calls: 1, Interrupted tool calls: 1/)
  })

  it('draws the partial output of a cut-short call without the error tint', () => {
    const blocks = projected(
      'sleep',
      interruptedAgentJournalToolCall({
        ...shell('sleep 20', 'running'),
        output: output('partial')
      })
    )
    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)
    openToolRunMembers()
    const body = [...container.querySelectorAll('pre')].find((pre) => pre.textContent === 'partial')
    expect(body).toBeDefined()
    expect(body).not.toHaveClass('text-destructive')
  })
})
