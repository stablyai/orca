// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from './messages/actions/native-chat-tooltip-test-harness'
import { useAppStore } from '@/store'
import {
  initialStore,
  resetSenderStore
} from './messages/agent-senders/native-chat-agent-sender.test-fixture'
import { NativeChatAgentMessageCard } from './messages/rows/NativeChatAgentMessageCard'
import type { AgentMessageSource } from '../../../../shared/agent-session/journal/agent-session-message-source'
import type { NativeChatBlock } from '../../../../shared/native-chat/native-chat-types'

beforeEach(() => resetSenderStore())

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(initialStore, true)
})

// Not a terminal this chat knows, so its name is plain words rather than an open button.
function source(message: 'task' | 'mail'): AgentMessageSource {
  return {
    kind: 'agent',
    senders: [
      {
        name: 'Parser',
        party: {
          address: 'dispatch:parser',
          terminalHandle: null,
          orcaSessionId: null
        }
      }
    ],
    orchestration:
      message === 'task'
        ? { message: 'task', runId: 'r', taskId: 't', dispatchId: 'd' }
        : {
            message: 'mail-notice',
            mailbox: 'term_9',
            dispatchId: null,
            messages: []
          }
  }
}

function card(blocks: NativeChatBlock[], message: 'task' | 'mail' = 'mail') {
  const from = source(message)
  return render(
    <NativeChatAgentMessageCard
      message={{
        id: 'mail',
        role: 'user',
        source: 'transcript',
        blocks,
        timestamp: null,
        from
      }}
      from={from}
      runtimeContext={{
        worktreeId: 'workspace',
        worktreePath: null,
        target: { kind: 'local' }
      }}
      onRefolded={() => {}}
    />
  )
}

const toggle = () => screen.queryByRole('button', { expanded: false })

it('names the row in full words with its first line, and opens the whole message in place of the line', () => {
  card([
    {
      type: 'text',
      text: 'PR **#4** is ready.\n\nMerge pending your go-ahead.'
    }
  ])

  const row = screen.getByRole('button', {
    name: 'Message from Parser: PR #4 is ready.'
  })
  expect(row).toHaveAttribute('aria-expanded', 'false')
  expect(row).not.toHaveAttribute('aria-label')
  expect(screen.getByText('PR #4 is ready.')).toBeVisible()
  expect(screen.queryByText('Merge pending your go-ahead.')).toBeNull()

  fireEvent.click(row)

  expect(row).toHaveAttribute('aria-expanded', 'true')
  const details = document.getElementById(row.getAttribute('aria-controls') ?? '')
  expect(details).toHaveTextContent('Merge pending your go-ahead.')
  expect(screen.queryByText('PR #4 is ready.')).toBeNull()
})

it('draws one kind word for a task, while its button keeps the full lead', () => {
  card([{ type: 'text', text: 'Review the dialog.\n\nRun its tests.' }], 'task')

  expect(screen.getByText('Task')).toBeVisible()
  expect(screen.queryByText('Task from')).toBeNull()
  expect(
    screen.getByRole('button', {
      name: 'Task from Parser: Review the dialog.'
    })
  ).toBeTruthy()
})

it('draws only the name and chevron for a message with no words', () => {
  card([{ type: 'image-ref', url: 'data:image/png;base64,AA==', alt: 'diagram' }])

  expect(screen.getByRole('button', { name: 'Message from Parser' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
})

it('shows a one-line message whole as a plain line with nothing to open', () => {
  card([{ type: 'text', text: 'Rebased on main.' }])

  expect(toggle()).toBeNull()
  expect(screen.getByText('Rebased on main.')).toBeVisible()
})

it('opens a one-line message the row cuts short', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(120)
  card([
    {
      type: 'text',
      text: 'Rebased on main, and every check is running again now.'
    }
  ])

  fireEvent.click(toggle()!)

  expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
})
