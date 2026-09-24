// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBackgroundTaskBlock } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from './native-chat-row-content'
import { NativeChatBackgroundTaskRun } from './NativeChatBackgroundTaskRun'

afterEach(cleanup)

function task(
  overrides: Partial<NativeChatBackgroundTaskBlock> = {}
): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId: 'byjnee2no',
    kind: 'command',
    label: 'Wait for the verification verdict',
    state: 'working',
    startedAt: 1_000,
    ...overrides
  }
}

describe('NativeChatBackgroundTaskRun', () => {
  it('draws the failure as a state, with the provider sentence beside it', () => {
    render(
      <NativeChatBackgroundTaskRun
        block={task({
          state: 'blocked',
          settledAt: 61_000,
          summary: 'Background command "Wait" failed with exit code 1',
          tokens: 18_200
        })}
      />
    )
    expect(screen.getByText('Wait for the verification verdict')).toBeInTheDocument()
    // The outcome is a state word plus its reason — the same vocabulary the
    // strip above the composer uses — not a red row of prose.
    expect(screen.getByText(/^blocked · failed · 18\.2k · 1m 0s$/)).toBeInTheDocument()
    expect(
      screen.getByText('Background command "Wait" failed with exit code 1')
    ).toBeInTheDocument()
  })

  it('never draws a wire opcode, whatever the task reported', () => {
    const { container } = render(<NativeChatBackgroundTaskRun block={task({ state: 'blocked' })} />)
    expect(container.textContent).not.toContain('message:system')
    expect(container.textContent).not.toContain('task_notification')
  })

  it('falls through to the kind when the provider named nothing usable', () => {
    render(<NativeChatBackgroundTaskRun block={task({ label: 'task', kind: 'workflow' })} />)
    expect(screen.getByText('Background workflow')).toBeInTheDocument()
  })

  it('reads a state this build has no word for as no contact, never as live', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: models a row a newer build wrote, which the wire admits as an open string.
    render(<NativeChatBackgroundTaskRun block={task({ state: 'teleported' as 'done' })} />)
    expect(screen.getByText(/unverifiable/)).toBeInTheDocument()
  })
})

describe('background task rows in a transcript message', () => {
  it('drops the frozen twin the block replaces, and keeps real prose', () => {
    const block = task({ state: 'blocked', summary: 'it failed' })
    const content = deriveNativeChatRowContent([
      { type: 'text', text: 'here is what happened' },
      { type: 'text', text: 'it failed' },
      block
    ])
    expect(content.markdown).toBe('here is what happened')
    expect(content.backgroundTasks).toEqual([block])
  })

  it('counts a task row as content, so the transcript reserves its slot', () => {
    const content = deriveNativeChatRowContent([
      { type: 'text', text: 'it failed' },
      task({ state: 'blocked', summary: 'it failed' })
    ])
    expect(content.markdown).toBe('')
    expect(content.backgroundTasks).toHaveLength(1)
  })
})
