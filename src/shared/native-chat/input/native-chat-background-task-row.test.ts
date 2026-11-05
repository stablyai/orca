import { describe, expect, it } from 'vitest'
import { claimBackgroundTaskTwins } from './native-chat-background-task-row'
import type { NativeChatBackgroundTaskBlock, NativeChatBlock } from '../native-chat-types'

function task(
  overrides: Partial<NativeChatBackgroundTaskBlock> = {}
): NativeChatBackgroundTaskBlock {
  return {
    type: 'background-task',
    taskId: 'task-1',
    kind: 'command',
    label: 'sleep 20',
    state: 'working',
    ...overrides
  }
}

describe('background task twins', () => {
  it('leaves real prose beside a row alone', () => {
    const row = task({ state: 'blocked', summary: 'it failed' })
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: 'here is what I found' },
      { type: 'text', text: 'it failed' },
      row
    ]
    expect([...claimBackgroundTaskTwins(blocks).twinTextIndexes]).toEqual([1])
  })

  it('gives two rows sharing a sentence one twin each', () => {
    const rows = [task({ taskId: 'a', state: 'done' }), task({ taskId: 'b', state: 'done' })]
    const blocks: NativeChatBlock[] = [
      { type: 'text', text: 'Background command "sleep 20" finished' },
      { type: 'text', text: 'Background command "sleep 20" finished' },
      ...rows
    ]
    const claims = claimBackgroundTaskTwins(blocks)
    expect([...claims.twinTextIndexes]).toEqual([0, 1])
    expect(claims.unpairedRows.size).toBe(0)
  })
})
