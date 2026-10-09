import { describe, expect, it } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyFromRuntime,
  applyLayoutFrame,
  EMPTY_WORKSPACE_LAYOUT_CACHE
} from './workspace-layout-cache'

function layout(worktreeId: string, tabIds: string[] = []): PublishedWorkspaceLayout {
  return {
    worktreeId,
    groups: [{ id: `group-${worktreeId}`, tabIds }],
    tabs: [],
    editorFiles: [],
    browserTabs: []
  }
}

describe('workspace layout cache', () => {
  it('applyFromRuntime replaces or drops one workspace and leaves the rest untouched', () => {
    const a = layout('a')
    const b = layout('b')
    const both = applyFromRuntime(applyFromRuntime(EMPTY_WORKSPACE_LAYOUT_CACHE, 'a', a), 'b', b)
    const a2 = layout('a', ['t1'])
    const replaced = applyFromRuntime(both, 'a', a2)
    expect(replaced).toEqual({ a: a2, b })
    expect(replaced.b).toBe(b)
    expect(both).toEqual({ a, b })
    expect(applyFromRuntime(replaced, 'a', null)).toEqual({ b })
    expect(applyFromRuntime(replaced, 'missing', null)).toBe(replaced)
    expect(applyFromRuntime(replaced, 'b', b)).toBe(replaced)
    expect(applyFromRuntime(replaced, 'b', layout('b'))).toBe(replaced)
  })

  it('a snapshot replaces the whole cache: absent workspaces go, nothing is merged', () => {
    const cache = { a: layout('a', ['t1', 't2']), b: layout('b') }
    const next = applyLayoutFrame(cache, {
      type: 'snapshot',
      subscriptionId: 'layout-2',
      workspaces: [
        { key: 'a', layout: layout('a', ['t2']) },
        { key: 'c', layout: layout('c') }
      ]
    })
    expect(next).toEqual({ a: layout('a', ['t2']), c: layout('c') })
  })

  it('a snapshot equal by value keeps the cache and every entry', () => {
    const cache = { a: layout('a', ['t1']), b: layout('b') }
    const next = applyLayoutFrame(cache, {
      type: 'snapshot',
      workspaces: [
        { key: 'a', layout: layout('a', ['t1']) },
        { key: 'b', layout: layout('b') }
      ]
    })
    expect(next).toBe(cache)
  })

  it('workspace and removed frames change only their workspace', () => {
    const b = layout('b')
    const cache = { a: layout('a'), b }
    const changed = applyLayoutFrame(cache, {
      type: 'workspace',
      key: 'a',
      layout: layout('a', ['t1'])
    })
    expect(changed).toEqual({ a: layout('a', ['t1']), b })
    expect(changed.b).toBe(b)
    expect(applyLayoutFrame(changed, { type: 'removed', key: 'a' })).toEqual({ b })
  })
})
