import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatTurnDiffs } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'

function diff(id: string, patch: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'tool-call', name: 'Diff', input: { path: 'page.html' } },
      { type: 'tool-result', output: patch }
    ]
  }
}

const edit = diff('edit', '@@ -1 +1 @@\n-old\n+new')
const removal = diff(
  'delete',
  'diff --git a/page.html b/page.html\ndeleted file mode 100644\n--- a/page.html\n+++ /dev/null\n@@ -1 +0,0 @@\n-old'
)
const recreate = diff(
  'recreate',
  'diff --git a/page.html b/page.html\nnew file mode 100644\n--- /dev/null\n+++ b/page.html\n@@ -0,0 +1 @@\n+new'
)

// A turn summary card opens the file only when that turn left it on disk.
describe('turn diff deleted state', () => {
  it('is deleted only when the turn ends with the file removed', () => {
    const removed = [edit, removal]
    const restored = [edit, removal, recreate]
    expect(nativeChatTurnDiffs(removed, ['t', 't']).get('t')?.files[0]?.deleted).toBe(true)
    expect(nativeChatTurnDiffs(restored, ['t', 't', 't']).get('t')?.files[0]?.deleted).toBe(false)
  })

  it('keeps a turn that deleted the file deleted when a later turn recreates it', () => {
    const turns = nativeChatTurnDiffs([removal, recreate], ['turn-1', 'turn-2'])
    expect(turns.get('turn-1')?.files[0]?.deleted).toBe(true)
    expect(turns.get('turn-2')?.files[0]?.deleted).toBe(false)
  })
})
