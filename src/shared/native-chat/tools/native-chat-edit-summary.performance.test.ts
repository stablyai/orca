import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatTurnDiffs, sameNativeChatTurnDiff } from './native-chat-turn-diffs'

// Count source normalization separately from rendered patches: unopened summaries still consume input.
describe('landed edit summary work', () => {
  it.each([100, 1000])('normalizes %i Claude edits once and only new input on append', (count) => {
    let contentReads = 0
    const edit = (index: number): NativeChatMessage => ({
      id: `edit-${index}`,
      role: 'assistant',
      source: 'transcript',
      timestamp: index,
      blocks: [
        {
          type: 'tool-call',
          name: 'Edit',
          state: 'completed',
          input: {
            file_path: `/repo/file-${index}.ts`,
            old_string: 'old-line\n'.repeat(40),
            get new_string() {
              contentReads += 1
              return 'new-line\n'.repeat(40)
            }
          }
        },
        { type: 'tool-result', output: 'The file was updated successfully.' }
      ]
    })
    const messages = Array.from({ length: count }, (_, index) => edit(index))
    const keys = messages.map(() => 'u')
    const first = nativeChatTurnDiffs(messages, keys).get('u')!
    expect(first.files).toHaveLength(count)
    const coldReads = contentReads
    expect(coldReads).toBeGreaterThanOrEqual(count)
    expect(coldReads).toBeLessThanOrEqual(count * 4)
    const same = nativeChatTurnDiffs([...messages], [...keys]).get('u')!
    expect(contentReads).toBe(coldReads)
    expect(sameNativeChatTurnDiff(first, same)).toBe(true)
    const appended = nativeChatTurnDiffs([...messages, edit(count)], [...keys, 'u']).get('u')!
    expect(appended.files).toHaveLength(count + 1)
    expect(contentReads - coldReads).toBe(coldReads / count)
    expect(sameNativeChatTurnDiff(first, appended)).toBe(false)
    const refreshed = [...messages]
    const last = refreshed[count - 1]!
    refreshed[count - 1] = {
      ...last,
      blocks: [last.blocks[0]!, { type: 'tool-result', output: 'Updated successfully.' }]
    }
    const beforeResult = contentReads
    nativeChatTurnDiffs(refreshed, keys)
    expect(contentReads - beforeResult).toBe(coldReads / count)
  })
})
