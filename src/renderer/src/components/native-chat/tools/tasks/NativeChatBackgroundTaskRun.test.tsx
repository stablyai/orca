// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import type { NativeChatBackgroundTaskBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatBackgroundTaskRun } from './NativeChatBackgroundTaskRun'

afterEach(cleanup)

function taskBlock(state: NativeChatBackgroundTaskBlock['state']): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId: 'task-1',
    kind: 'command',
    label: 'npm test',
    state,
    error: 'exit code 1'
  }
}

describe('blocked glyph', () => {
  it('draws a live blocked agent with the needs-you question glyph', () => {
    const { container } = render(<AgentStateDot state="blocked" title={null} />)
    const marker = container.querySelector('[aria-label="Blocked"]')
    expect(marker?.querySelector('svg.text-agent-question')).not.toBeNull()
    expect(marker?.querySelector('.bg-red-500')).toBeNull()
  })

  it('keeps a failed background task on the red failure dot', () => {
    const { container } = render(<NativeChatBackgroundTaskRun block={taskBlock('blocked')} />)
    const marker = container.querySelector('[aria-label="Failed"]')
    expect(marker?.querySelector('.bg-red-500')).not.toBeNull()
    expect(container.querySelector('svg.text-agent-question')).toBeNull()
  })
})
