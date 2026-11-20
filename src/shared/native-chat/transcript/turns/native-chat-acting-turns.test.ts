import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatActingTurnKeys } from './native-chat-acting-turns'

const row = (id: string, fields: Partial<NativeChatMessage> = {}): NativeChatMessage => ({
  id,
  role: 'assistant',
  timestamp: 0,
  source: 'transcript',
  blocks: [],
  ...fields
})
const quiet = (id: string): NativeChatMessage =>
  row(id, { blocks: [{ type: 'text', text: 'NO_REPLY' }] })
const comment: NativeChatMessage['botItemNote'] = {
  noteId: 'n1',
  by: 'bot',
  entries: [
    { uid: 'i1', number: 41917, title: 'Fix', status: 'working', event: 'commented', text: 'Done' }
  ]
}

describe('quiet turns that did something others see', () => {
  it('counts a turn whose bot commented on an item', () => {
    const rows = [row('note', { botItemNote: comment }), quiet('end')]
    expect([...nativeChatActingTurnKeys(rows, ['t1', 't1'])]).toEqual(['t1'])
  })

  it('counts a turn that posted to Slack', () => {
    const post = row('post', {
      blocks: [
        {
          type: 'tool-call',
          name: 'Bash',
          input: { command: '"${ORCA_CLI_COMMAND:-orca}" slack post T1:C9 "Merged"' }
        }
      ]
    })
    expect([...nativeChatActingTurnKeys([post, quiet('end')], ['t1', 't1'])]).toEqual(['t1'])
  })

  it('counts a turn that said something before its quiet result', () => {
    const said = row('said', { blocks: [{ type: 'text', text: 'Checked the reviews.' }] })
    expect([...nativeChatActingTurnKeys([said, quiet('end')], ['t1', 't1'])]).toEqual(['t1'])
  })

  it('leaves a turn that only read, or the owner’s own item change', () => {
    const read = row('read', {
      blocks: [
        { type: 'tool-call', name: 'Bash', input: { command: 'orca slack read T1:C9' } },
        { type: 'tool-call', name: 'Bash', input: { command: 'echo "slack post"' } }
      ]
    })
    const owner = row('owner', { role: 'user', botItemNote: { ...comment, by: 'owner' } })
    expect(nativeChatActingTurnKeys([owner, read, quiet('end')], ['t1', 't1', 't1']).size).toBe(0)
  })
})
