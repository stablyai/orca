import { expect, it } from 'vitest'
import { structuredAgentSessionToolCallBlock } from '../../agent-session/view/messages/structured-agent-session-tool-call-block'
import type { NativeChatBlock } from '../native-chat-types'
import { buildEditSummaries } from './native-chat-edit-cards'

it('lists each file when one Codex diff is labeled with a file count', () => {
  const first = '@@ -1 +1 @@\n-Original A\n+Updated A\n@@ -4 +4 @@\n-Old\n+New\n'
  const second = '@@ -1 +1 @@\n-Original B\n+Updated B\n'
  const patch = `${first}\n${second}`
  const call = structuredAgentSessionToolCallBlock(
    {
      kind: 'diff',
      path: '2 files',
      paths: ['a.txt', 'b.txt'],
      patch: { head: patch, byteLength: patch.length, digest: 'abc', truncated: false }
    },
    'item-1'
  )
  const blocks: NativeChatBlock[] = [
    call,
    { type: 'tool-result', output: patch, callId: call.callId }
  ]
  const files = [...buildEditSummaries(blocks).values()][0]?.files

  expect(files?.map((file) => [file.path, file.added, file.removed])).toEqual([
    ['a.txt', 2, 2],
    ['b.txt', 1, 1]
  ])
})
