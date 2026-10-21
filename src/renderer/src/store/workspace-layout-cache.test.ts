import { describe, expect, it } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { applyLayoutFrame, EMPTY_WORKSPACE_LAYOUT_CACHE } from './workspace-layout-cache'

function layout(worktreeId: string, tabIds: string[] = []): PublishedWorkspaceLayout {
  return {
    worktreeId,
    groups: [{ id: `group-${worktreeId}`, tabIds }],
    tabs: [],
    editorFiles: [],
    browserTabs: []
  }
}

describe('applyLayoutFrame', () => {
  it('a workspace frame replaces one workspace and leaves the rest untouched', () => {
    const b = layout('b')
    const cache = { a: layout('a'), b }
    const next = applyLayoutFrame(cache, {
      type: 'workspace',
      key: 'a',
      layout: layout('a', ['t1'])
    })
    expect(next).toEqual({ a: layout('a', ['t1']), b })
    expect(next.b).toBe(b)
    expect(cache).toEqual({ a: layout('a'), b })
    expect(
      applyLayoutFrame(EMPTY_WORKSPACE_LAYOUT_CACHE, { type: 'workspace', key: 'c', layout: b })
    ).toEqual({ c: b })
  })

  it('a removed frame drops one workspace; an absent one keeps the cache', () => {
    const b = layout('b')
    const cache = { a: layout('a'), b }
    const next = applyLayoutFrame(cache, { type: 'removed', key: 'a' })
    expect(next).toEqual({ b })
    expect(next.b).toBe(b)
    expect(applyLayoutFrame(next, { type: 'removed', key: 'a' })).toBe(next)
  })

  it('a snapshot replaces the whole cache: absent workspaces go, nothing is merged', () => {
    const b = layout('b')
    const cache = { a: layout('a', ['t1', 't2']), b, gone: layout('gone') }
    const next = applyLayoutFrame(cache, {
      type: 'snapshot',
      workspaces: [
        { key: 'a', layout: layout('a', ['t2']) },
        { key: 'b', layout: layout('b') },
        { key: 'c', layout: layout('c') }
      ]
    })
    expect(next).toEqual({ a: layout('a', ['t2']), b, c: layout('c') })
    // An equal entry keeps its object, so its readers do not re-render.
    expect(next.b).toBe(b)
  })

  it('a snapshot equal by value keeps the cache object', () => {
    const cache = { a: layout('a', ['t1']), b: layout('b') }
    const equal = applyLayoutFrame(cache, {
      type: 'snapshot',
      workspaces: [
        { key: 'a', layout: layout('a', ['t1']) },
        { key: 'b', layout: layout('b') }
      ]
    })
    expect(equal).toBe(cache)
    const subset = applyLayoutFrame(cache, {
      type: 'snapshot',
      workspaces: [{ key: 'a', layout: layout('a', ['t1']) }]
    })
    expect(subset).toEqual({ a: cache.a })
    expect(subset.a).toBe(cache.a)
  })
})
