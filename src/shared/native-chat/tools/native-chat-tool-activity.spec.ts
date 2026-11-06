import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../native-chat-types'
import { selectActiveToolCall } from './native-chat-tool-activity'

function call(
  name: string,
  input: unknown,
  state?: 'running' | 'completed' | 'failed'
): Extract<NativeChatBlock, { type: 'tool-call' }> {
  return { type: 'tool-call', name, input, ...(state ? { state } : {}) } as Extract<
    NativeChatBlock,
    { type: 'tool-call' }
  >
}

describe('selectActiveToolCall', () => {
  it('returns nothing once the turn is known to have ended', () => {
    const blocks = [call('Bash', { command: 'x' }, 'running')]
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: false })).toBeNull()
  })

  it('picks the latest explicitly running call', () => {
    const blocks = [
      call('Read', { file_path: 'a' }, 'completed'),
      call('Bash', { command: 'x' }, 'running'),
      call('Grep', { pattern: 'y' }, 'running')
    ]
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: true })?.name).toBe('Grep')
  })

  it('ignores settled calls even while the turn works', () => {
    const blocks = [call('Read', { file_path: 'a' }, 'completed')]
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: true })).toBeNull()
  })

  it('treats a lifecycle-less call as running only while the turn works', () => {
    const blocks = [call('Read', { file_path: 'a' })]
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: true })?.name).toBe('Read')
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: undefined })).toBeNull()
  })

  it('still surfaces an explicitly running call when the turn state is unknown', () => {
    const blocks = [call('Bash', { command: 'x' }, 'running')]
    expect(selectActiveToolCall(blocks, { activeTurnIsWorking: undefined })?.name).toBe('Bash')
  })
})
