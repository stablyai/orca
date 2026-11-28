import { describe, expect, it } from 'vitest'
import { keptMentionHighlight } from './use-native-chat-kept-mention-highlight'

describe('keptMentionHighlight', () => {
  const files = ['src/a.ts', 'src/b.ts']
  const grown = ['host-chat:c', 'host-terminal:t', 'src/a.ts', 'src/b.ts']
  const shown = { rows: files, query: '', value: 'src/b.ts' }

  it('keeps the highlighted row when rows arrive above it with no edit', () => {
    expect(keptMentionHighlight(shown, grown, '', 1)).toBe(3)
  })

  it('leaves the highlight to the arrow keys and to edits', () => {
    // An arrow key moves the highlight over the same rows.
    expect(keptMentionHighlight({ ...shown, value: 'src/a.ts' }, files, '', 1)).toBe(1)
    // An edit changes the query; the edit sets the highlight.
    expect(keptMentionHighlight(shown, grown, 'b', 0)).toBe(0)
  })
})
