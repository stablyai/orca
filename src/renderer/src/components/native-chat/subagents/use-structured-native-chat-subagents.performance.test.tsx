// @vitest-environment happy-dom
import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { useStructuredNativeChatSubagents } from './use-structured-native-chat-subagents'

const strip = vi.hoisted(() => ({ renders: 0 }))

vi.mock('../tools/tasks/NativeChatBackgroundTasksStatus', () => ({
  NativeChatBackgroundTasksStatus: () => {
    strip.renders++
    return null
  }
}))

const RUNNING: StructuredSessionBackgroundTasksView = {
  show: true,
  isMonitoring: true,
  tasks: [{ id: 'task-1', kind: 'agent', description: 'Explore', state: 'working' }],
  settledTasks: [],
  supportsStop: true,
  offersStopAll: true,
  incomplete: false
}

// The session holds its target across updates; tests are not compiled, so keep it stable here.
const LOCAL = { kind: 'local' } as const
const NO_CLEARS = { clears: 0 }

/** A structured chat as its session mounts it: each update builds a new controller. */
function Chat(_props: { update: number }) {
  const subagents = useStructuredNativeChatSubagents({
    sessionId: 'session-1',
    target: LOCAL,
    paneKey: 'tab_chat:pane',
    isVisible: true,
    controller: {
      backgroundTasks: RUNNING,
      stopBackgroundTask: async () => null,
      prompts: [],
      epoch: null,
      contextClear: NO_CLEARS
    }
  })
  return subagents.chip
}

it('keeps the agents strip still while its session updates and its work does not change', () => {
  const view = render(<Chat update={0} />)
  expect(strip.renders).toBe(1)
  for (let update = 1; update <= 50; update++) {
    view.rerender(<Chat update={update} />)
  }
  expect(strip.renders).toBe(1)
  view.unmount()
})
