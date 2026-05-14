import { describe, expect, it } from 'vitest'
import { findLeakedDiffModelPaths, type DiffModelCandidate } from './editor-model-leak'

function diffModel(path: string): DiffModelCandidate {
  return { scheme: 'diff', path }
}

describe('findLeakedDiffModelPaths — changes mode', () => {
  const tabId = 'tab-abc'

  it('flags single-pane modified and rotated original paths', () => {
    const models = [
      diffModel(`modified:${tabId}`),
      diffModel(`original:${tabId}:original:deadbeef`),
      diffModel(`original:other-tab:original:cafebabe`),
      diffModel(`modified:other-tab`),
      { scheme: 'unrelated', path: 'foo' }
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'changes')).toEqual([
      `modified:${tabId}`,
      `original:${tabId}:original:deadbeef`
    ])
  })

  it('flags split-pane modified and rotated original paths', () => {
    const models = [
      diffModel(`modified:${tabId}::pane-2`),
      diffModel(`original:${tabId}::pane-2:original:deadbeef`),
      diffModel(`modified:${tabId}::pane-3`),
      diffModel(`original:${tabId}::pane-3:original:cafebabe`)
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'changes').sort()).toEqual(
      [
        `modified:${tabId}::pane-2`,
        `modified:${tabId}::pane-3`,
        `original:${tabId}::pane-2:original:deadbeef`,
        `original:${tabId}::pane-3:original:cafebabe`
      ].sort()
    )
  })

  it('handles multiple rotations of the same tab simultaneously', () => {
    const models = [
      diffModel(`modified:${tabId}`),
      diffModel(`original:${tabId}:original:hash1`),
      diffModel(`original:${tabId}:original:hash2`),
      diffModel(`original:${tabId}:original:hash3`)
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'changes').sort()).toEqual(
      [
        `modified:${tabId}`,
        `original:${tabId}:original:hash1`,
        `original:${tabId}:original:hash2`,
        `original:${tabId}:original:hash3`
      ].sort()
    )
  })

  it('does not match a tab id whose prefix is shared with a longer id', () => {
    const models = [
      diffModel(`modified:${tabId}-extended`),
      diffModel(`original:${tabId}-extended:original:hash`)
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'changes')).toEqual([])
  })

  it('does not flag a plain-diff style original path in changes mode', () => {
    // Why: in changes mode the original path always has a `:original:${hash}`
    // suffix, so a bare `original:${tabId}` (no trailing `:`) belongs to
    // a plain diff tab and must not match.
    const models = [diffModel(`original:${tabId}`)]
    expect(findLeakedDiffModelPaths(models, tabId, 'changes')).toEqual([])
  })

  it('matches when tab id is an absolute file path (real-world Changes-mode shape)', () => {
    // Why: the real-world tab id is an absolute file path, so the URI looks
    // like `monaco.Uri.parse('diff:modified:' + filePath + '::' + scope)`.
    // Monaco's `URI.toString()` percent-encodes the `:` characters in the
    // path segment, but `URI.path` keeps them literal — which is why the
    // helper matches against `path` rather than `toString()`. This locks in
    // the encoding-mismatch fix.
    const filePath = '/Users/me/repo/file.md'
    const scope = 'scope-id-1'
    const hash = 'a9ce8f37'
    const models = [
      diffModel(`modified:${filePath}::${scope}`),
      diffModel(`original:${filePath}::${scope}:original:${hash}`)
    ]
    expect(findLeakedDiffModelPaths(models, filePath, 'changes').sort()).toEqual(
      [`modified:${filePath}::${scope}`, `original:${filePath}::${scope}:original:${hash}`].sort()
    )
  })
})

describe('findLeakedDiffModelPaths — diff mode', () => {
  const tabId = 'tab-xyz'

  it('flags single-pane modified and exact original paths', () => {
    const models = [
      diffModel(`modified:${tabId}`),
      diffModel(`original:${tabId}`),
      diffModel(`modified:other-tab`),
      diffModel(`original:other-tab`)
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'diff').sort()).toEqual(
      [`modified:${tabId}`, `original:${tabId}`].sort()
    )
  })

  it('flags split-pane modified and original paths', () => {
    const models = [
      diffModel(`modified:${tabId}::pane-2`),
      diffModel(`original:${tabId}::pane-2`),
      diffModel(`modified:${tabId}::pane-3`),
      diffModel(`original:${tabId}::pane-3`)
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'diff').sort()).toEqual(
      [
        `modified:${tabId}::pane-2`,
        `modified:${tabId}::pane-3`,
        `original:${tabId}::pane-2`,
        `original:${tabId}::pane-3`
      ].sort()
    )
  })

  it('does not flag a rotated-original path in diff mode', () => {
    // Why: plain diff tabs do not rotate the original path, so a path with a
    // `:original:${hash}` suffix belongs to a Changes-mode tab and must not
    // be disposed when a plain diff tab closes.
    const models = [diffModel(`original:${tabId}:original:hash`)]
    expect(findLeakedDiffModelPaths(models, tabId, 'diff')).toEqual([])
  })

  it('returns empty when no paths match', () => {
    const models = [
      diffModel(`modified:other`),
      { scheme: 'unrelated', path: 'foo' },
      diffModel('bar')
    ]
    expect(findLeakedDiffModelPaths(models, tabId, 'diff')).toEqual([])
  })
})
