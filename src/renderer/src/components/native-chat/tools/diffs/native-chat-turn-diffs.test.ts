import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

import {
  buildEditSummaries,
  buildEditCards
} from '../../../../../../shared/native-chat/tools/native-chat-edit-cards'
import { nativeChatTurnDiffs } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'

function diff(id: string, path: string, patch = '@@ -1 +1 @@\n-old\n+new'): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'tool-call', name: 'Diff', input: { path } },
      { type: 'tool-result', output: patch }
    ]
  }
}

describe('turn diff rollups', () => {
  it('folds edits through chained renames into the destination and counts a deletion once', () => {
    const messages = [
      diff('edit', 'old.ts'),
      diff(
        'rename',
        'old.ts',
        'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts'
      ),
      diff(
        'rename-again',
        'new.ts',
        'diff --git a/new.ts b/final.ts\nrename from new.ts\nrename to final.ts'
      ),
      diff(
        'delete',
        'gone.ts',
        'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone'
      )
    ]
    const turn = nativeChatTurnDiffs(
      messages,
      messages.map(() => 'turn')
    ).get('turn')!
    expect(turn.files.map((file) => file.path)).toEqual(['final.ts', 'gone.ts'])
    expect(turn).toMatchObject({ added: 1, removed: 2 })
    expect(turn.files[0]?.target.messageId).toBe('rename-again')
    expect(turn.files[0]?.edits.map((edit) => edit.target.messageId)).toEqual([
      'edit',
      'rename',
      'rename-again'
    ])
  })

  it('keeps every patch in order when a rename joins two already edited paths', () => {
    const messages = [
      diff('destination', 'new.ts'),
      diff('source', 'old.ts'),
      diff('rename', 'old.ts', 'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts')
    ]
    const turn = nativeChatTurnDiffs(
      messages,
      messages.map(() => 'turn')
    ).get('turn')!
    expect(turn.files).toHaveLength(1)
    expect(turn.files[0]?.edits.map((edit) => edit.target.messageId)).toEqual([
      'destination',
      'source',
      'rename'
    ])
    expect(turn).toMatchObject({ added: 2, removed: 2 })
  })

  it('keeps turns separate and excludes history without a known boundary', () => {
    const result = nativeChatTurnDiffs(
      [diff('orphan', 'orphan.ts'), diff('a', 'a.ts'), diff('b', 'a.ts')],
      [undefined, 'one', 'two']
    )
    expect([...result.keys()]).toEqual(['one', 'two'])
    expect(result.get('one')?.added).toBe(1)
    expect(result.get('two')?.files).toHaveLength(1)
  })

  it('caches counts and deferred card models separately and refreshes new results', () => {
    const message = diff('a', 'a.ts')
    const summary = [...buildEditSummaries(message.blocks).values()][0]!.files
    expect([...buildEditSummaries([...message.blocks]).values()][0]!.files).toBe(summary)
    expect(summary[0]).not.toHaveProperty('lines')
    const first = [...buildEditCards(message.blocks).editCards.values()][0]!.files
    expect([...buildEditCards([...message.blocks]).editCards.values()][0]!.files).toBe(first)
    message.blocks = [
      message.blocks[0]!,
      { type: 'tool-result', output: '@@ -0,0 +1,2 @@\n+one\n+two' }
    ]
    const updated = [...buildEditCards(message.blocks).editCards.values()][0]!.files
    expect(updated).not.toBe(first)
    expect(updated[0]?.added).toBe(2)
    const updatedSummary = [...buildEditSummaries(message.blocks).values()][0]!.files
    expect(updatedSummary).not.toBe(summary)
    expect(updatedSummary[0]?.added).toBe(2)
  })
})
