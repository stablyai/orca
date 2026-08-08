import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  buildRoomActivitySections,
  completedRoomActivity,
  formatRoomActivityDuration
} from './room-activity-timeline'

describe('room activity timeline', () => {
  it('keeps commentary order and pairs Claude-style tool results', () => {
    const messages: NativeChatMessage[] = [
      message('thinking', 'assistant', 10, [{ type: 'text', text: 'Inspecting the files.' }]),
      message('read', 'assistant', 20, [
        { type: 'tool-call', name: 'Read', input: { file_path: 'src/app.ts' } }
      ]),
      message('result', 'tool', 30, [{ type: 'tool-result', output: 'source' }]),
      message('command', 'assistant', 40, [
        { type: 'tool-call', name: 'Bash', input: { command: 'wc -l src/app.ts' } }
      ]),
      message('edit', 'assistant', 50, [
        {
          type: 'tool-call',
          name: 'exec',
          input: 'await tools.apply_patch(`*** Begin Patch\n*** End Patch`)'
        }
      ])
    ]

    const sections = buildRoomActivitySections(messages)
    expect(sections).toHaveLength(2)
    expect(sections[0]).toMatchObject({ kind: 'commentary', text: 'Inspecting the files.' })
    expect(sections[1]).toMatchObject({
      kind: 'tools',
      tools: [
        { kind: 'reading', result: { output: 'source' } },
        { kind: 'command', result: null },
        { kind: 'editing', result: null }
      ]
    })
  })

  it('reads durable metadata and formats elapsed time', () => {
    const activity = {
      state: 'completed' as const,
      messages: [],
      startedAt: 1_000,
      completedAt: 129_000
    }
    expect(completedRoomActivity({ activity })).toEqual(activity)
    expect(completedRoomActivity({ activity: { state: 'completed' } })).toBeNull()
    expect(formatRoomActivityDuration(activity.startedAt, activity.completedAt)).toBe('2m 8s')
  })
})

function message(
  id: string,
  role: NativeChatMessage['role'],
  timestamp: number,
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id, role, timestamp, blocks, source: 'transcript' }
}
