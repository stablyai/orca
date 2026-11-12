import { describe, expect, it } from 'vitest'
import type { PublishedWorkspaceLayout } from '../../../../shared/workspace-layout/published-layout/workspace-layout-published'
import { applyLayoutFrame } from './workspace-layout-cache'

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
})
