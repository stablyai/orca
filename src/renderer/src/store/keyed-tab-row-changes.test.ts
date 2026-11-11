import { describe, expect, it } from 'vitest'
import { markFullResync, replaceTabBuckets, tabBucketDraft } from './keyed-record-transitions'
import { readTabRowChanges } from './keyed-tab-row-changes'

describe('addressed tab row references', () => {
  it('retains replacement, addition and deletion endpoints across writes', () => {
    const original = { id: 'terminal', label: 'before' }
    const renamed = { ...original, label: 'after' }
    const removed = { id: 'removed', label: 'removed' }
    const added = { id: 'added', label: 'added' }
    const start = { workspace: [original, removed] }
    const changed = replaceTabBuckets(start, [['workspace', [renamed, removed]]])
    const draft = tabBucketDraft(changed)
    draft.set('workspace', [renamed, added])
    const result = readTabRowChanges(draft.finish(), start)
    expect(result !== 'unknown' && result?.get('workspace')).toEqual(
      new Map([
        ['terminal', { before: original, after: renamed }],
        ['added', { before: undefined, after: added }],
        ['removed', { before: removed, after: undefined }]
      ])
    )
    if (result && result !== 'unknown') {
      expect(result.get('workspace')?.get('terminal')?.before).toBe(original)
      expect(result.get('workspace')?.get('terminal')?.after).toBe(renamed)
    }
  })

  it('composes net endpoints when intermediate row changes are undone', () => {
    const original = { id: 'terminal', label: 'before' }
    const start = { workspace: [original] }
    const renamed = replaceTabBuckets(start, [
      ['workspace', [{ ...original, label: 'intermediate' }]]
    ])
    const restored = replaceTabBuckets(renamed, [['workspace', [original]]])
    expect(readTabRowChanges(restored, start)).toEqual(
      new Map([['workspace', new Map([['terminal', { before: original, after: original }]])]])
    )
    expect(readTabRowChanges(start, start)).toBeNull()
  })

  it('requires resync when a removed row is reinserted across skipped writes', () => {
    const a = { id: 'a', contentType: 'terminal', entityId: 't0', groupId: 'g' }
    const b = { id: 'b', contentType: 'terminal', entityId: 't0', groupId: 'h' }
    const start = { workspace: [a, b] }
    const removed = replaceTabBuckets(start, [['workspace', [b]]])
    const reinserted = replaceTabBuckets(removed, [['workspace', [b, a]]])
    expect(readTabRowChanges(reinserted, start)).toBe('unknown')
  })

  it('requires resync for unavailable or reordered histories', () => {
    const first = { id: 'first' }
    const second = { id: 'second' }
    const start = { workspace: [first, second] }
    expect(readTabRowChanges({ workspace: [first] }, start)).toBe('unknown')
    expect(readTabRowChanges(markFullResync({ workspace: [first] }, 'hydration'), start)).toBe(
      'unknown'
    )
    expect(
      readTabRowChanges(replaceTabBuckets(start, [['workspace', [second, first]]]), start)
    ).toBe('unknown')
  })
})
