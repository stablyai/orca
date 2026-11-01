// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatSubagentActivity } from '../../../../shared/native-chat/input/native-chat-activity'
import { NativeChatActivityBar } from './NativeChatActivityBar'

function agent(
  id: string,
  label: string,
  state: NativeChatSubagentActivity['state']
): NativeChatSubagentActivity {
  return { id, label, state, activity: null }
}

const listed = [
  agent('run', 'Runner', 'working'),
  agent('bad', 'Checker', 'failed'),
  agent('lost', 'Scout', 'unverifiable')
]

function bar(
  seed: readonly NativeChatSubagentActivity[] = listed,
  onFocusSubagent: (agentId: string | null) => void = () => {}
) {
  return (
    <NativeChatActivityBar
      messages={[]}
      subagentRows={new Map()}
      focusedSubagentId={null}
      onFocusSubagent={onFocusSubagent}
      subagentSeed={seed}
      sessionId="sess-1"
    />
  )
}

function openSheet(): void {
  fireEvent.click(screen.getByRole('button', { name: /subagent/i }))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

it('dismisses failed children from the sheet, the pill, and the next mount', () => {
  const view = render(bar())
  openSheet()
  expect(screen.getByTestId('native-chat-dismiss-all-failed')).toHaveTextContent(
    'Dismiss all failed'
  )
  expect(screen.getAllByTestId('native-chat-dismiss-subagent')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Dismiss Runner' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Checker' }))
  expect(screen.getByRole('button', { name: /2 subagent/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Dismiss Checker' })).toBeNull()
  expect(screen.queryByTestId('native-chat-dismiss-all-failed')).toBeNull()

  view.unmount()
  render(bar())
  openSheet()
  expect(screen.queryByRole('button', { name: 'Dismiss Checker' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Dismiss Scout' })).toBeInTheDocument()
})

it('keeps completed children off the pill and lists them only inside an open sheet', () => {
  const onFocusSubagent = vi.fn()
  render(
    bar(
      [
        ...listed,
        agent('done', 'Greeter', 'completed'),
        agent('other', 'Checker two', 'completed')
      ],
      onFocusSubagent
    )
  )
  expect(screen.getByRole('button', { name: /3 subagent/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Greeter' })).toBeNull()
  openSheet()
  fireEvent.click(screen.getByTestId('native-chat-completed-subagents'))
  fireEvent.click(screen.getByRole('button', { name: 'Greeter' }))
  expect(onFocusSubagent).toHaveBeenCalledWith('done')
})

it('hides the pill when every remaining child is dismissed', () => {
  render(bar([agent('bad', 'Checker', 'failed'), agent('lost', 'Scout', 'unverifiable')]))
  openSheet()
  fireEvent.click(screen.getByTestId('native-chat-dismiss-all-failed'))
  expect(screen.queryByRole('button', { name: /subagent/i })).toBeNull()
})

it('shows a dismissed child again after it reports a new state', () => {
  const view = render(bar())
  openSheet()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss Checker' }))
  view.rerender(
    bar([
      agent('run', 'Runner', 'working'),
      agent('bad', 'Checker', 'working'),
      agent('lost', 'Scout', 'unverifiable')
    ])
  )
  expect(screen.getByRole('button', { name: '3 subagents' })).toBeInTheDocument()
  if (!screen.queryByText('Checker')) {
    openSheet()
  }
  expect(screen.getByText('Checker')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Dismiss Checker' })).toBeNull()
})
