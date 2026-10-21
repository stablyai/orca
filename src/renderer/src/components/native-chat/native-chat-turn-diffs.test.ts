import { MAX_EDIT_LINES } from '../../../../shared/native-chat-edit-model'
import { describe, expect, it } from 'vitest'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { foldToolMessages } from './native-chat-tool-fold'
import { buildDiffSummaries, buildEditCards } from '../../../../shared/native-chat-edit-cards'
import { nativeChatTurnDiffEditFile, nativeChatTurnDiffs } from './native-chat-turn-diffs'

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
  it('counts unique files, sums recorded edits, and targets the last existing card', () => {
    const messages = foldToolMessages([
      diff('first', 'a.ts'),
      diff('second', 'a.ts'),
      diff('third', 'b.ts')
    ])
    const turn = nativeChatTurnDiffs(messages, ['turn']).get('turn')!
    expect(turn.files).toHaveLength(2)
    expect(turn).toMatchObject({ added: 3, removed: 3, truncated: false })
    expect(turn.files[0]).toMatchObject({
      path: 'a.ts',
      added: 2,
      target: { messageId: 'first', editKey: 'Diff:1', fileIndex: 0 }
    })
    expect(turn.files[0]?.edits).toHaveLength(2)
    expect(turn.files[0]?.edits.map(nativeChatTurnDiffEditFile)).toMatchObject([
      { path: 'a.ts', added: 1, removed: 1 },
      { path: 'a.ts', added: 1, removed: 1 }
    ])
  })

  it('resolves only the selected file edits in a folded message and reuses their patches', () => {
    const bodyReads = [0, 0, 0]
    const messages = foldToolMessages(
      ['selected.ts', 'closed.ts', 'selected.ts'].map((path, index) => ({
        ...diff(`edit-${index}`, path),
        blocks: [
          { type: 'tool-call' as const, name: 'Diff', input: { path } },
          {
            type: 'tool-result' as const,
            get output() {
              bodyReads[index] = (bodyReads[index] ?? 0) + 1
              return `@@ -1 +1 @@\n-old-${index}\n+new-${index}`
            }
          }
        ]
      }))
    )
    expect(messages).toHaveLength(1)
    const turn = nativeChatTurnDiffs(messages, ['turn']).get('turn')!
    bodyReads.fill(0)
    const selected = turn.files.find((file) => file.path === 'selected.ts')!
    const patches = selected.edits.map(nativeChatTurnDiffEditFile)
    expect(bodyReads).toEqual([1, 0, 1])
    expect(patches.map((patch) => patch?.lines.at(-1)?.text)).toEqual(['new-0', 'new-2'])
    expect(selected.edits.map(nativeChatTurnDiffEditFile)[0]).toBe(patches[0])
    expect(selected.edits.map(nativeChatTurnDiffEditFile)[1]).toBe(patches[1])
    expect(bodyReads).toEqual([1, 0, 1])
    const originalCards = buildEditCards(messages[0]!.blocks).editCards
    expect(originalCards.get(selected.edits[0]!.call)?.files[0]).toBe(patches[0])
    expect(originalCards.get(selected.edits[1]!.call)?.files[0]).toBe(patches[1])
  })

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

  it('uses the existing multi-file parser and preserves truncated counts', () => {
    const patch =
      'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-old\n+new\n… (9999 bytes)'
    const turn = nativeChatTurnDiffs([diff('multi', 'changes', patch)], ['turn']).get('turn')!
    expect(turn.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
    expect(turn).toMatchObject({ added: 2, removed: 2, truncated: true })
    expect(turn.files[1]?.target.fileIndex).toBe(1)
    expect(turn.files[1]?.edits.map(nativeChatTurnDiffEditFile)).toMatchObject([{ path: 'b.ts' }])
  })

  it('does not count generic output, failed edits, running edits, or unparseable patches', () => {
    const messages = ['shell', 'Edit'].map((name) => ({
      ...diff(name, 'x'),
      blocks: [
        { type: 'tool-call', name, input: { path: 'x' } },
        { type: 'tool-result', output: '@@ -1 +1 @@\n-old\n+new' }
      ] as NativeChatBlock[]
    }))
    messages.push(diff('invalid', 'x', 'no patch'))
    for (const state of ['running', 'failed'] as const) {
      const message = diff(state, 'x')
      message.blocks[0] = { type: 'tool-call', name: 'Diff', input: { path: 'x' }, state }
      messages.push(message)
    }
    expect(
      nativeChatTurnDiffs(
        messages,
        messages.map(() => 'turn')
      ).size
    ).toBe(0)
  })

  it('leaves non-journal Diff envelopes to the deferred tool card', () => {
    for (const input of [{ path: 'x', patch: '@@\n+override' }, { file_path: 'x' }, null]) {
      const message = diff('generic', 'x')
      message.blocks[0] = { type: 'tool-call', name: 'Diff', input }
      expect(buildDiffSummaries(message.blocks).size).toBe(0)
    }
  })

  it('caches counts and deferred card models separately and refreshes new results', () => {
    const message = diff('a', 'a.ts')
    const summary = [...buildDiffSummaries(message.blocks).values()][0]!.files
    expect([...buildDiffSummaries([...message.blocks]).values()][0]!.files).toBe(summary)
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
    const updatedSummary = [...buildDiffSummaries(message.blocks).values()][0]!.files
    expect(updatedSummary).not.toBe(summary)
    expect(updatedSummary[0]?.added).toBe(2)
  })

  it.each([
    '@@ -1 +1 @@\n-old\n+new',
    '@@\n--- content\n+++ content\n\\ No newline at end of file',
    '@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-again\n+again',
    'diff --git a/a.ts b/b.ts\nrename from a.ts\nrename to b.ts',
    `@@ -0,0 +1,2500 @@\n${'+new\n'.repeat(MAX_EDIT_LINES + 1)}`,
    `@@ -0,0 +1,2500 @@\n${'+new\n'.repeat(MAX_EDIT_LINES - 1)}@@ -1 +1 @@\n+last`,
    '@@ -1 +1 @@\n-old\n+new\n… (9999 bytes)'
  ])('keeps lightweight counts identical to the expanded card (case %#)', (patch) => {
    const message = diff('parity', 'a.ts', patch)
    const summary = [...buildDiffSummaries(message.blocks).values()][0]!.files
    const detailed = [...buildEditCards(message.blocks).editCards.values()][0]!.files
    expect(summary).toEqual(
      detailed.map(({ lines: _lines, lineNumbersKnown: _known, ...file }) => file)
    )
  })
})
