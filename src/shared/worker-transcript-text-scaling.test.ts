import { expect, it, vi } from 'vitest'
import { formatWorkerTranscriptMessage } from './worker-transcript-text'
import type { NativeChatMessage } from './native-chat-types'

it('does not shift the remaining twin list for each matching roster', () => {
  const blocks: NativeChatMessage['blocks'] = Array.from({ length: 1000 }, (_, index) => ({
    type: 'subagent-group',
    groupId: `g-${index}`,
    agents: [{ id: 'child', label: 'task', state: 'working' }]
  }))
  blocks.push(
    ...Array.from({ length: 1000 }, () => ({
      type: 'text' as const,
      text: 'Kicked off 1 subagent'
    }))
  )
  const original = Array.prototype.splice
  let shifted = 0
  const spy = vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
    this: unknown[],
    ...args: [number, number, ...unknown[]]
  ) {
    if (this[0] === 'Kicked off 1 subagent') {
      shifted += this.length - args[0] - args[1]
    }
    return original.apply(this, args)
  })
  let output: string
  try {
    output = formatWorkerTranscriptMessage({
      id: 'm',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks
    })
  } finally {
    spy.mockRestore()
  }
  expect(output!).toBe(`[assistant] ${Array(1000).fill('Kicked off 1 subagent').join('\n')}`)
  expect(shifted).toBe(0)
})
