// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatToolLine } from './NativeChatToolLine'
import {
  NativeChatForegroundTaskAction,
  NativeChatForegroundTasksProvider
} from './NativeChatForegroundTaskAction'
import type {
  AgentSessionForegroundTask,
  AgentSessionBackgroundResult
} from '../../../../shared/agent-session/agent-session-foreground-task'

afterEach(cleanup)

it('lets the running command and its task row share one targeted action, then removes it on completion', async () => {
  const requests: AgentSessionForegroundTask[] = []
  const answer = Promise.withResolvers<AgentSessionBackgroundResult | null>()
  const target = {
    toolUseId: 'toolu_build',
    taskId: 'shell-31',
    turnId: 'turn-7',
    generation: 'process-4'
  }
  const renderCalls = (tasks: AgentSessionForegroundTask[]) => (
    <NativeChatForegroundTasksProvider
      tasks={tasks}
      backgroundTask={(task) => {
        requests.push(task)
        return answer.promise
      }}
    >
      <NativeChatToolLine
        block={{
          type: 'tool-call',
          callId: 'toolu_build',
          name: 'Bash',
          input: { command: 'pnpm build' },
          state: 'running'
        }}
      />
      <NativeChatForegroundTaskAction taskId="shell-31" />
    </NativeChatForegroundTasksProvider>
  )
  const view = render(renderCalls([target]))
  fireEvent.click(screen.getAllByRole('button', { name: 'Background' })[0]!)
  expect(requests).toEqual([
    { toolUseId: 'toolu_build', taskId: 'shell-31', turnId: 'turn-7', generation: 'process-4' }
  ])
  expect(
    screen
      .getAllByRole('button', { name: 'Backgrounding…' })
      .every((button) => button.hasAttribute('disabled'))
  ).toBe(true)
  await act(async () => answer.resolve({ backgrounded: true }))
  view.rerender(renderCalls([]))
  expect(screen.queryByRole('button', { name: /Background/ })).toBeNull()
})
